#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Define memory file path using environment variable with fallback
const defaultMemoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.json');

// If MEMORY_FILE_PATH is just a filename, put it in the same directory as the script
const MEMORY_FILE_PATH = process.env.MEMORY_FILE_PATH
  ? path.isAbsolute(process.env.MEMORY_FILE_PATH)
    ? process.env.MEMORY_FILE_PATH
    : path.join(path.dirname(fileURLToPath(import.meta.url)), process.env.MEMORY_FILE_PATH)
  : defaultMemoryPath;

// We are storing our memory using entities, relations, and observations in a graph structure
interface Metadata {
  sourceFile?: string;
  confidence: 'high' | 'medium' | 'low';
  accessCount: number;
  lastAccessedAt?: string;  // ISO date string
}

interface Entity {
  name: string;
  entityType: string;
  observations: string[];
  // New required temporal fields with ISO date strings
  createdAt: string;  // ISO date string
  updatedAt: string;  // ISO date string
  previousObservations: string[] | null;
  metadata: Metadata;
}

interface Relation {
  from: string;
  to: string;
  relationType: string;
}

interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

// Create default metadata for new entities
function createDefaultMetadata(sourceFile?: string): Metadata {
  return {
    sourceFile,
    confidence: 'high',
    accessCount: 0,
    lastAccessedAt: new Date().toISOString()
  };
}

// Storage version for future migrations
const STORAGE_VERSION = 2;

// Helper to create a properly formatted entity with all required fields
function createEntity(name: string, entityType: string, observations: string[], metadata?: Partial<Metadata>): Entity {
  const now = new Date().toISOString();
  return {
    name,
    entityType,
    observations,
    createdAt: now,
    updatedAt: now,
    previousObservations: null,
    metadata: metadata ? { ...createDefaultMetadata(), ...metadata } : createDefaultMetadata()
  };
}

// Helper function to calculate Levenshtein distance for fuzzy matching
function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];
  
  // If one string is empty, return the length of the other
  if (str1.length === 0) return str2.length;
  if (str2.length === 0) return str1.length;
  
  // Initialize the matrix
  for (let i = 0; i <= str1.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= str2.length; j++) {
    matrix[0][j] = j;
  }
  
  // Calculate distances
  for (let i = 1; i <= str1.length; i++) {
    for (let j = 1; j <= str2.length; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  
  return matrix[str1.length][str2.length];
}

// The KnowledgeGraphManager class contains all operations to interact with the knowledge graph
class KnowledgeGraphManager {
  private writeLock = false;
  private writeLockQueue: (() => void)[] = [];
  
  private async acquireWriteLock(): Promise<void> {
    while (this.writeLock) {
      await new Promise<void>(resolve => this.writeLockQueue.push(resolve));
    }
    this.writeLock = true;
  }
  
  private releaseWriteLock(): void {
    this.writeLock = false;
    const next = this.writeLockQueue.shift();
    if (next) next();
  }

  private async loadGraph(): Promise<KnowledgeGraph> {
    try {
      const data = await fs.readFile(MEMORY_FILE_PATH, "utf-8");
      const lines = data.split("\n").filter(line => line.trim() !== "");
      return lines.reduce((graph: KnowledgeGraph, line, index) => {
        try {
          const item = JSON.parse(line);
          if (item.type === "meta") {
            // Skip meta line but could check version here in future
            return graph;
          }
          if (item.type === "entity") {
            // Remove type from stored entity before adding
            const { type, ...entity } = item;
            graph.entities.push(entity as Entity);
          }
          if (item.type === "relation") {
            const { type, ...relation } = item;
            graph.relations.push(relation as Relation);
          }
        } catch (parseError) {
          console.error(`Skipping corrupt line ${index + 1}: ${parseError}`);
        }
        return graph;
      }, { entities: [], relations: [] });
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code === "ENOENT") {
        return { entities: [], relations: [] };
      }
      throw error;
    }
  }

  private async saveGraph(graph: KnowledgeGraph): Promise<void> {
    const lines = [
      JSON.stringify({ type: "meta", version: STORAGE_VERSION, timestamp: new Date().toISOString() }),
      ...graph.entities.map(e => JSON.stringify({ type: "entity", ...e })),
      ...graph.relations.map(r => JSON.stringify({ type: "relation", ...r })),
    ];
    
    // Write to temp file first for atomic operation
    const tempPath = `${MEMORY_FILE_PATH}.tmp`;
    await fs.writeFile(tempPath, lines.join("\n"));
    
    // Ensure data is flushed to disk before rename
    const fd = await fs.open(tempPath, 'r');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
    
    // Atomic rename (on POSIX systems)
    await fs.rename(tempPath, MEMORY_FILE_PATH);
  }

  async createEntities(entities: Entity[]): Promise<Entity[]> {
    await this.acquireWriteLock();
    try {
      const graph = await this.loadGraph();
      
      // Since all fields are required, just filter for duplicates
      const newEntities = entities.filter(e => 
        !graph.entities.some(existingEntity => existingEntity.name === e.name)
      );
      
      graph.entities.push(...newEntities);
      await this.saveGraph(graph);
      return newEntities;
    } finally {
      this.releaseWriteLock();
    }
  }

  async createRelations(relations: Relation[]): Promise<{
    created: Relation[];
    skipped: Relation[];
    errors: Array<{ relation: Relation; error: string }>;
  }> {
    await this.acquireWriteLock();
    try {
      const graph = await this.loadGraph();
      const entityNames = new Set(graph.entities.map(e => e.name));
      
      const created: Relation[] = [];
      const skipped: Relation[] = [];
      const errors: Array<{ relation: Relation; error: string }> = [];
      
      for (const relation of relations) {
        // Validate entities exist
        if (!entityNames.has(relation.from)) {
          errors.push({ relation, error: `Source entity '${relation.from}' does not exist` });
          continue;
        }
        if (!entityNames.has(relation.to)) {
          errors.push({ relation, error: `Target entity '${relation.to}' does not exist` });
          continue;
        }
        
        // Check if relation already exists
        const exists = graph.relations.some(r =>
          r.from === relation.from && 
          r.to === relation.to && 
          r.relationType === relation.relationType
        );
        
        if (exists) {
          skipped.push(relation);
        } else {
          created.push(relation);
          graph.relations.push(relation);
        }
      }
      
      if (created.length > 0) {
        await this.saveGraph(graph);
      }
      
      return { created, skipped, errors };
    } finally {
      this.releaseWriteLock();
    }
  }

  async addObservations(observations: { entityName: string; contents: string[] }[]): Promise<{
    success: Array<{ entityName: string; addedObservations: string[]; skippedDuplicates: string[] }>;
    errors: Array<{ entityName: string; error: string }>;
  }> {
    await this.acquireWriteLock();
    try {
      const graph = await this.loadGraph();
      const success: Array<{ entityName: string; addedObservations: string[]; skippedDuplicates: string[] }> = [];
      const errors: Array<{ entityName: string; error: string }> = [];
      let hasChanges = false;
    
    for (const obs of observations) {
      const entity = graph.entities.find(e => e.name === obs.entityName);
      
      if (!entity) {
        errors.push({ 
          entityName: obs.entityName, 
          error: `Entity '${obs.entityName}' does not exist. Please create it first using create_entities.` 
        });
        continue;
      }
      
      const addedObservations: string[] = [];
      const skippedDuplicates: string[] = [];
      
      for (const content of obs.contents) {
        if (entity.observations.includes(content)) {
          skippedDuplicates.push(content);
        } else {
          entity.observations.push(content);
          addedObservations.push(content);
          hasChanges = true;
        }
      }
      
      // Update timestamps if observations were added
      if (addedObservations.length > 0) {
        entity.updatedAt = new Date().toISOString();
      }
      
      success.push({ 
        entityName: obs.entityName, 
        addedObservations,
        skippedDuplicates 
      });
    }
    
      if (hasChanges) {
        await this.saveGraph(graph);
      }
      
      return { success, errors };
    } finally {
      this.releaseWriteLock();
    }
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    await this.acquireWriteLock();
    try {
      const graph = await this.loadGraph();
      graph.entities = graph.entities.filter(e => !entityNames.includes(e.name));
      graph.relations = graph.relations.filter(r => !entityNames.includes(r.from) && !entityNames.includes(r.to));
      await this.saveGraph(graph);
    } finally {
      this.releaseWriteLock();
    }
  }

  async deleteObservations(deletions: { entityName: string; observations: string[] }[]): Promise<void> {
    await this.acquireWriteLock();
    try {
      const graph = await this.loadGraph();
      deletions.forEach(d => {
        const entity = graph.entities.find(e => e.name === d.entityName);
        if (entity) {
          entity.observations = entity.observations.filter(o => !d.observations.includes(o));
        }
      });
      await this.saveGraph(graph);
    } finally {
      this.releaseWriteLock();
    }
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    await this.acquireWriteLock();
    try {
      const graph = await this.loadGraph();
      graph.relations = graph.relations.filter(r => !relations.some(delRelation => 
        r.from === delRelation.from && 
        r.to === delRelation.to && 
        r.relationType === delRelation.relationType
      ));
      await this.saveGraph(graph);
    } finally {
      this.releaseWriteLock();
    }
  }

  async updateEntity(name: string, updates: { observations?: string[]; metadata?: Partial<Metadata> }): Promise<Entity | null> {
    await this.acquireWriteLock();
    try {
      const graph = await this.loadGraph();
    const entity = graph.entities.find(e => e.name === name);
    
    if (!entity) {
      return null;
    }
    
    // Save current observations to previousObservations if observations are being updated
    if (updates.observations && updates.observations.join('|') !== entity.observations.join('|')) {
      entity.previousObservations = [...entity.observations];
    }
    
    // Update observations if provided
    if (updates.observations) {
      entity.observations = updates.observations;
    }
    
    // Update metadata if provided
    if (updates.metadata) {
      entity.metadata = { ...entity.metadata, ...updates.metadata };
    }
    
    // Always update the timestamp and increment access count
    entity.updatedAt = new Date().toISOString();
    entity.metadata.accessCount++;
    entity.metadata.lastAccessedAt = new Date().toISOString();
    
      await this.saveGraph(graph);
      return entity;
    } finally {
      this.releaseWriteLock();
    }
  }

  async readGraph(): Promise<KnowledgeGraph> {
    return this.loadGraph();
  }

  // Very basic search function
  async searchNodes(query: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    
    // Filter entities
    const filteredEntities = graph.entities.filter(e => 
      e.name.toLowerCase().includes(query.toLowerCase()) ||
      e.entityType.toLowerCase().includes(query.toLowerCase()) ||
      e.observations.some(o => o.toLowerCase().includes(query.toLowerCase()))
    );
  
    // Increment access count for searched entities
    for (const entity of filteredEntities) {
      await this.incrementAccessCount(entity.name);
    }
  
    // Create a Set of filtered entity names for quick lookup
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
  
    // Filter relations to only include those between filtered entities
    const filteredRelations = graph.relations.filter(r => 
      filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );
  
    const filteredGraph: KnowledgeGraph = {
      entities: filteredEntities,
      relations: filteredRelations,
    };
  
    return filteredGraph;
  }

  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    
    // Filter entities
    const filteredEntities = graph.entities.filter(e => names.includes(e.name));
  
    // Increment access count for opened entities
    for (const entity of filteredEntities) {
      await this.incrementAccessCount(entity.name);
    }
  
    // Create a Set of filtered entity names for quick lookup
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
  
    // Filter relations to only include those between filtered entities
    const filteredRelations = graph.relations.filter(r => 
      filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );
  
    const filteredGraph: KnowledgeGraph = {
      entities: filteredEntities,
      relations: filteredRelations,
    };
  
    return filteredGraph;
  }

  async getStaleEntities(days: number, entityType?: string): Promise<Array<{
    entity: Entity;
    daysSinceUpdate: number;
    recommendation: string;
  }>> {
    const graph = await this.loadGraph();
    const now = new Date();
    const millisecondsInDay = 24 * 60 * 60 * 1000;
    const staleThreshold = new Date(now.getTime() - (days * millisecondsInDay));
    
    let entities = graph.entities.filter(e => new Date(e.updatedAt) < staleThreshold);
    
    // Filter by entity type if provided
    if (entityType) {
      entities = entities.filter(e => e.entityType === entityType);
    }
    
    return entities.map(entity => {
      const daysSinceUpdate = Math.floor((now.getTime() - new Date(entity.updatedAt).getTime()) / millisecondsInDay);
      const recommendation = entity.metadata.accessCount > 10 
        ? `High-use entity (${entity.metadata.accessCount} accesses), consider refreshing soon`
        : `Low-use entity (${entity.metadata.accessCount} accesses), may not need immediate refresh`;
        
      return {
        entity,
        daysSinceUpdate,
        recommendation
      };
    }).sort((a, b) => b.entity.metadata.accessCount - a.entity.metadata.accessCount);
  }

  async validateComponentProps(componentName: string, propsToCheck: string[]): Promise<{
    valid: boolean;
    invalidProps: string[];
    validProps: string[];
    allAvailableProps: string[];
    staleness: {
      days: number;
      warning?: string;
    };
  } | null> {
    const graph = await this.loadGraph();
    const entity = graph.entities.find(e => e.name === componentName && e.entityType === 'component');
    
    if (!entity) {
      return null;
    }
    
    // Increment access count since we're using this entity
    entity.metadata.accessCount++;
    entity.metadata.lastAccessedAt = new Date().toISOString();
    await this.saveGraph(graph);
    
    // Extract @props from observations
    const propObservations = entity.observations.filter(o => o.startsWith('@props '));
    const allAvailableProps = propObservations.map(o => {
      const propDef = o.substring(7); // Remove '@props ' prefix
      const propName = propDef.split(':')[0].trim();
      return propName.replace('?', ''); // Remove optional indicator
    });
    
    // Check which props are valid/invalid
    const validProps = propsToCheck.filter(p => allAvailableProps.includes(p));
    const invalidProps = propsToCheck.filter(p => !allAvailableProps.includes(p));
    
    // Calculate staleness
    const now = new Date();
    const daysSinceUpdate = Math.floor((now.getTime() - new Date(entity.updatedAt).getTime()) / (24 * 60 * 60 * 1000));
    const staleness = {
      days: daysSinceUpdate,
      warning: daysSinceUpdate > 7 ? `Component info is ${daysSinceUpdate} days old, consider verifying` : undefined
    };
    
    return {
      valid: invalidProps.length === 0,
      invalidProps,
      validProps,
      allAvailableProps,
      staleness
    };
  }

  async getFrequentlyUsed(minAccessCount: number, entityType?: string): Promise<Entity[]> {
    const graph = await this.loadGraph();
    
    let entities = graph.entities.filter(e => e.metadata.accessCount >= minAccessCount);
    
    // Filter by entity type if provided
    if (entityType) {
      entities = entities.filter(e => e.entityType === entityType);
    }
    
    // Sort by access count descending
    return entities.sort((a, b) => b.metadata.accessCount - a.metadata.accessCount);
  }

  // Helper to increment access count without returning the entity
  async incrementAccessCount(entityName: string): Promise<void> {
    await this.acquireWriteLock();
    try {
      const graph = await this.loadGraph();
      const entity = graph.entities.find(e => e.name === entityName);
      
      if (entity) {
        entity.metadata.accessCount++;
        entity.metadata.lastAccessedAt = new Date().toISOString();
        await this.saveGraph(graph);
      }
    } finally {
      this.releaseWriteLock();
    }
  }

  // Verify graph integrity by checking for orphaned entities in relationships
  async verifyGraphIntegrity(maxSuggestions: number = 3): Promise<{
    isValid: boolean;
    orphanedRelations: Array<{
      relation: Relation;
      missingEntity: string;
      entityPosition: 'from' | 'to';
      suggestions: Array<{
        name: string;
        entityType: string;
        similarity: number;
      }>;
    }>;
    summary: {
      totalRelations: number;
      validRelations: number;
      orphanedRelations: number;
      uniqueOrphanedEntities: string[];
    };
  }> {
    const graph = await this.loadGraph();
    const entityNames = new Set(graph.entities.map(e => e.name));
    const orphanedRelations: Array<{
      relation: Relation;
      missingEntity: string;
      entityPosition: 'from' | 'to';
      suggestions: Array<{
        name: string;
        entityType: string;
        similarity: number;
      }>;
    }> = [];
    const uniqueOrphanedEntities = new Set<string>();

    // Check each relation for orphaned entities
    for (const relation of graph.relations) {
      const fromExists = entityNames.has(relation.from);
      const toExists = entityNames.has(relation.to);

      if (!fromExists) {
        uniqueOrphanedEntities.add(relation.from);
        const suggestions = this.findSimilarEntities(relation.from, graph.entities, maxSuggestions);
        orphanedRelations.push({
          relation,
          missingEntity: relation.from,
          entityPosition: 'from',
          suggestions
        });
      }

      if (!toExists) {
        uniqueOrphanedEntities.add(relation.to);
        const suggestions = this.findSimilarEntities(relation.to, graph.entities, maxSuggestions);
        orphanedRelations.push({
          relation,
          missingEntity: relation.to,
          entityPosition: 'to',
          suggestions
        });
      }
    }

    const isValid = orphanedRelations.length === 0;
    const totalRelations = graph.relations.length;
    const validRelations = totalRelations - orphanedRelations.length;

    return {
      isValid,
      orphanedRelations,
      summary: {
        totalRelations,
        validRelations,
        orphanedRelations: orphanedRelations.length,
        uniqueOrphanedEntities: Array.from(uniqueOrphanedEntities)
      }
    };
  }

  // Helper to find similar entities using fuzzy matching
  private findSimilarEntities(targetName: string, entities: Entity[], maxSuggestions: number): Array<{
    name: string;
    entityType: string;
    similarity: number;
  }> {
    const targetLower = targetName.toLowerCase();
    const suggestions: Array<{
      name: string;
      entityType: string;
      similarity: number;
      distance: number;
    }> = [];

    for (const entity of entities) {
      const entityLower = entity.name.toLowerCase();
      
      // Calculate similarity metrics
      const distance = levenshteinDistance(targetLower, entityLower);
      const maxLength = Math.max(targetName.length, entity.name.length);
      const similarity = 1 - (distance / maxLength);
      
      // Also check for substring matches (case-insensitive)
      const hasSubstring = entityLower.includes(targetLower) || targetLower.includes(entityLower);
      
      // Boost similarity for substring matches
      const adjustedSimilarity = hasSubstring ? Math.max(similarity, 0.7) : similarity;
      
      // Only include if similarity is above threshold
      if (adjustedSimilarity > 0.3) {
        suggestions.push({
          name: entity.name,
          entityType: entity.entityType,
          similarity: adjustedSimilarity,
          distance
        });
      }
    }

    // Sort by similarity (descending) and distance (ascending)
    suggestions.sort((a, b) => {
      if (Math.abs(a.similarity - b.similarity) < 0.01) {
        return a.distance - b.distance;
      }
      return b.similarity - a.similarity;
    });

    // Return top suggestions
    return suggestions.slice(0, maxSuggestions).map(s => ({
      name: s.name,
      entityType: s.entityType,
      similarity: Math.round(s.similarity * 100) / 100
    }));
  }
}

const knowledgeGraphManager = new KnowledgeGraphManager();


// The server instance and tools exposed to Claude
const server = new Server({
  name: "memory-server",
  version: "0.6.3",
},    {
    capabilities: {
      tools: {},
    },
  },);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_entities",
        description: "Create multiple new entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            entities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "The name of the entity" },
                  entityType: { type: "string", description: "The type of the entity" },
                  observations: { 
                    type: "array", 
                    items: { type: "string" },
                    description: "An array of observation contents associated with the entity"
                  },
                },
                required: ["name", "entityType", "observations"],
              },
            },
          },
          required: ["entities"],
        },
      },
      {
        name: "create_relations",
        description: "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
        inputSchema: {
          type: "object",
          properties: {
            relations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: { type: "string", description: "The name of the entity where the relation starts" },
                  to: { type: "string", description: "The name of the entity where the relation ends" },
                  relationType: { type: "string", description: "The type of the relation" },
                },
                required: ["from", "to", "relationType"],
              },
            },
          },
          required: ["relations"],
        },
      },
      {
        name: "add_observations",
        description: "Add new observations to existing entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            observations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  entityName: { type: "string", description: "The name of the entity to add the observations to" },
                  contents: { 
                    type: "array", 
                    items: { type: "string" },
                    description: "An array of observation contents to add"
                  },
                },
                required: ["entityName", "contents"],
              },
            },
          },
          required: ["observations"],
        },
      },
      {
        name: "delete_entities",
        description: "Delete multiple entities and their associated relations from the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            entityNames: { 
              type: "array", 
              items: { type: "string" },
              description: "An array of entity names to delete" 
            },
          },
          required: ["entityNames"],
        },
      },
      {
        name: "delete_observations",
        description: "Delete specific observations from entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            deletions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  entityName: { type: "string", description: "The name of the entity containing the observations" },
                  observations: { 
                    type: "array", 
                    items: { type: "string" },
                    description: "An array of observations to delete"
                  },
                },
                required: ["entityName", "observations"],
              },
            },
          },
          required: ["deletions"],
        },
      },
      {
        name: "delete_relations",
        description: "Delete multiple relations from the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            relations: { 
              type: "array", 
              items: {
                type: "object",
                properties: {
                  from: { type: "string", description: "The name of the entity where the relation starts" },
                  to: { type: "string", description: "The name of the entity where the relation ends" },
                  relationType: { type: "string", description: "The type of the relation" },
                },
                required: ["from", "to", "relationType"],
              },
              description: "An array of relations to delete" 
            },
          },
          required: ["relations"],
        },
      },
      {
        name: "read_graph",
        description: "Read the entire knowledge graph",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "search_nodes",
        description: "Search for nodes in the knowledge graph based on a query",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query to match against entity names, types, and observation content" },
          },
          required: ["query"],
        },
      },
      {
        name: "open_nodes",
        description: "Open specific nodes in the knowledge graph by their names",
        inputSchema: {
          type: "object",
          properties: {
            names: {
              type: "array",
              items: { type: "string" },
              description: "An array of entity names to retrieve",
            },
          },
          required: ["names"],
        },
      },
      {
        name: "get_stale_entities",
        description: "Find entities that haven't been updated recently",
        inputSchema: {
          type: "object",
          properties: {
            days: { 
              type: "number", 
              description: "Number of days to consider an entity stale" 
            },
            entityType: { 
              type: "string", 
              description: "Optional: filter by entity type (e.g., 'component', 'service')" 
            },
          },
          required: ["days"],
        },
      },
      {
        name: "validate_component_props",
        description: "Validate component props to prevent hallucination. Checks if props exist in @props observations",
        inputSchema: {
          type: "object",
          properties: {
            componentName: { 
              type: "string", 
              description: "Name of the component to validate" 
            },
            propsToCheck: { 
              type: "array",
              items: { type: "string" },
              description: "Array of prop names to validate" 
            },
          },
          required: ["componentName", "propsToCheck"],
        },
      },
      {
        name: "update_entity",
        description: "Update an existing entity, preserving previous observations",
        inputSchema: {
          type: "object",
          properties: {
            name: { 
              type: "string", 
              description: "Name of the entity to update" 
            },
            observations: { 
              type: "array",
              items: { type: "string" },
              description: "New observations (optional)" 
            },
            metadata: { 
              type: "object",
              description: "Partial metadata to update (optional)" 
            },
          },
          required: ["name"],
        },
      },
      {
        name: "get_frequently_used",
        description: "Find entities that are accessed frequently",
        inputSchema: {
          type: "object",
          properties: {
            minAccessCount: { 
              type: "number", 
              description: "Minimum access count threshold" 
            },
            entityType: { 
              type: "string", 
              description: "Optional: filter by entity type" 
            },
          },
          required: ["minAccessCount"],
        },
      },
      {
        name: "verify_graph_integrity",
        description: "Verify the integrity of the knowledge graph by checking for orphaned entities in relationships. Returns hallucinated entity names with fuzzy search suggestions.",
        inputSchema: {
          type: "object",
          properties: {
            maxSuggestions: { 
              type: "number", 
              description: "Maximum number of similar entity suggestions to return for each orphaned entity (default: 3)" 
            },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new Error(`No arguments provided for tool: ${name}`);
  }

  switch (name) {
    case "create_entities":
      // Transform simplified input to full Entity objects
      const fullEntities = (args.entities as any[]).map(e => 
        createEntity(e.name, e.entityType, e.observations)
      );
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.createEntities(fullEntities), null, 2) }] };
    case "create_relations":
      const relResult = await knowledgeGraphManager.createRelations(args.relations as Relation[]);
      let relMessage = "";
      if (relResult.created.length > 0) {
        relMessage += `Created ${relResult.created.length} new relation(s).\n`;
      }
      if (relResult.skipped.length > 0) {
        relMessage += `Skipped ${relResult.skipped.length} duplicate relation(s).\n`;
      }
      if (relResult.errors.length > 0) {
        relMessage += `\nErrors:\n`;
        relResult.errors.forEach(e => {
          relMessage += `- ${e.error}\n`;
        });
      }
      return { content: [{ type: "text", text: relMessage + "\n" + JSON.stringify(relResult, null, 2) }] };
    case "add_observations":
      const obsResult = await knowledgeGraphManager.addObservations(args.observations as { entityName: string; contents: string[] }[]);
      let obsMessage = "";
      
      if (obsResult.success.length > 0) {
        obsMessage += "Successfully processed:\n";
        obsResult.success.forEach(s => {
          if (s.addedObservations.length > 0) {
            obsMessage += `- ${s.entityName}: Added ${s.addedObservations.length} observation(s)\n`;
          }
          if (s.skippedDuplicates.length > 0) {
            obsMessage += `  (Skipped ${s.skippedDuplicates.length} duplicate(s))\n`;
          }
        });
      }
      
      if (obsResult.errors.length > 0) {
        obsMessage += "\nErrors:\n";
        obsResult.errors.forEach(e => {
          obsMessage += `- ${e.error}\n`;
        });
      }
      
      return { content: [{ type: "text", text: obsMessage + "\n" + JSON.stringify(obsResult, null, 2) }] };
    case "delete_entities":
      await knowledgeGraphManager.deleteEntities(args.entityNames as string[]);
      return { content: [{ type: "text", text: "Entities deleted successfully" }] };
    case "delete_observations":
      await knowledgeGraphManager.deleteObservations(args.deletions as { entityName: string; observations: string[] }[]);
      return { content: [{ type: "text", text: "Observations deleted successfully" }] };
    case "delete_relations":
      await knowledgeGraphManager.deleteRelations(args.relations as Relation[]);
      return { content: [{ type: "text", text: "Relations deleted successfully" }] };
    case "read_graph":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.readGraph(), null, 2) }] };
    case "search_nodes":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.searchNodes(args.query as string), null, 2) }] };
    case "open_nodes":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.openNodes(args.names as string[]), null, 2) }] };
    case "get_stale_entities":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.getStaleEntities(args.days as number, args.entityType as string | undefined), null, 2) }] };
    case "validate_component_props":
      const validationResult = await knowledgeGraphManager.validateComponentProps(args.componentName as string, args.propsToCheck as string[]);
      if (!validationResult) {
        return { content: [{ type: "text", text: `Component "${args.componentName}" not found` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(validationResult, null, 2) }] };
    case "update_entity":
      const updatedEntity = await knowledgeGraphManager.updateEntity(
        args.name as string, 
        { 
          observations: args.observations as string[] | undefined,
          metadata: args.metadata as Partial<Metadata> | undefined
        }
      );
      if (!updatedEntity) {
        return { content: [{ type: "text", text: `Entity "${args.name}" not found` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(updatedEntity, null, 2) }] };
    case "get_frequently_used":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.getFrequentlyUsed(args.minAccessCount as number, args.entityType as string | undefined), null, 2) }] };
    case "verify_graph_integrity":
      const integrityResult = await knowledgeGraphManager.verifyGraphIntegrity(args.maxSuggestions as number | undefined);
      let integrityMessage = "";
      
      if (integrityResult.isValid) {
        integrityMessage = "✅ Graph integrity verified: All relationships reference valid entities.\n\n";
      } else {
        integrityMessage = `⚠️ Graph integrity issues found: ${integrityResult.orphanedRelations.length} orphaned relationship(s)\n\n`;
        integrityMessage += `Unique hallucinated entities (${integrityResult.summary.uniqueOrphanedEntities.length}):\n`;
        integrityResult.summary.uniqueOrphanedEntities.forEach(entity => {
          integrityMessage += `- ${entity}\n`;
        });
        integrityMessage += "\nDetailed orphaned relationships:\n";
        integrityResult.orphanedRelations.forEach((orphan, index) => {
          integrityMessage += `\n${index + 1}. Relation: ${orphan.relation.from} --[${orphan.relation.relationType}]--> ${orphan.relation.to}\n`;
          integrityMessage += `   Missing entity: '${orphan.missingEntity}' (${orphan.entityPosition})\n`;
          if (orphan.suggestions.length > 0) {
            integrityMessage += `   Did you mean:\n`;
            orphan.suggestions.forEach(suggestion => {
              integrityMessage += `   - ${suggestion.name} (${suggestion.entityType}) - ${Math.round(suggestion.similarity * 100)}% match\n`;
            });
          } else {
            integrityMessage += `   No similar entities found.\n`;
          }
        });
      }
      
      integrityMessage += `\nSummary:\n`;
      integrityMessage += `- Total relations: ${integrityResult.summary.totalRelations}\n`;
      integrityMessage += `- Valid relations: ${integrityResult.summary.validRelations}\n`;
      integrityMessage += `- Orphaned relations: ${integrityResult.summary.orphanedRelations}\n`;
      
      return { content: [{ type: "text", text: integrityMessage + "\n" + JSON.stringify(integrityResult, null, 2) }] };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
