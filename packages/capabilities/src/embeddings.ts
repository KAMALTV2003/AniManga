import { deterministicId, stableStringify } from '@nexus-ai/core';
import type { SqliteDatabase } from '@nexus-ai/database';

import type { EmbeddingIndexResult, EmbeddingProvider } from './types.js';
import { capabilityError, requirePositiveInteger, requireSimpleKey } from './validation.js';

export const MAX_EXACT_EMBEDDING_VALUES = 5_000_000;

interface IndexDocumentRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly searchText: string;
  readonly contentHash: string;
}

export class CapabilityEmbeddingIndex {
  readonly #database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  async indexProject(
    projectId: string,
    provider: EmbeddingProvider,
    options: { readonly batchSize?: number; readonly maxDocuments?: number } = {},
  ): Promise<EmbeddingIndexResult> {
    const providerName = requireSimpleKey(provider.provider, 'embedding provider');
    const model = requireSimpleKey(provider.model, 'embedding model');
    const dimensions = requirePositiveInteger(provider.dimensions, 'embedding dimensions', 8_192);
    const batchSize = requirePositiveInteger(options.batchSize ?? 32, 'batchSize', 128);
    const maxDocuments = requirePositiveInteger(
      options.maxDocuments ?? 1_000,
      'maxDocuments',
      1_000,
    );
    assertProject(this.#database, projectId);

    const counts = this.#database.connection
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN e.content_sha256 = d.content_sha256
                              AND e.dimensions = ? THEN 1 ELSE 0 END) AS unchanged
         FROM capability_documents d
         LEFT JOIN capability_embeddings e
           ON e.document_id = d.id AND e.provider = ? AND e.model = ?
         WHERE d.project_id = ? AND d.status = 'active'`,
      )
      .get(dimensions, providerName, model, projectId) as {
      readonly total: number;
      readonly unchanged: number | null;
    };
    if (counts.total > 10_000 || counts.total * dimensions > MAX_EXACT_EMBEDDING_VALUES) {
      throw capabilityError(
        'CAPABILITY_EMBEDDING_LIMIT',
        'Exact local embedding indexes exceed the bounded document or vector-value budget',
        {
          documents: counts.total,
          dimensions,
          maximumVectorValues: MAX_EXACT_EMBEDDING_VALUES,
        },
      );
    }
    const documents = this.#database.connection
      .prepare(
        `SELECT d.id, d.name, d.description, d.search_text AS searchText,
                d.content_sha256 AS contentHash
         FROM capability_documents d
         LEFT JOIN capability_embeddings e
           ON e.document_id = d.id AND e.provider = ? AND e.model = ?
         WHERE d.project_id = ? AND d.status = 'active'
           AND (e.id IS NULL OR e.content_sha256 <> d.content_sha256 OR e.dimensions <> ?)
         ORDER BY d.id LIMIT ?`,
      )
      .all(providerName, model, projectId, dimensions, maxDocuments) as IndexDocumentRow[];

    let indexed = 0;
    for (let offset = 0; offset < documents.length; offset += batchSize) {
      const batch = documents.slice(offset, offset + batchSize);
      const vectors = await provider.embed(batch.map((document) => embeddingText(document)));
      if (vectors.length !== batch.length) {
        throw capabilityError(
          'EMBEDDING_RESPONSE_INVALID',
          'Embedding provider returned a different vector count than requested',
          { requested: batch.length, received: vectors.length },
        );
      }
      const validated = vectors.map((vector, index) => {
        try {
          return validateVector(vector, dimensions);
        } catch (error) {
          throw capabilityError(
            'EMBEDDING_RESPONSE_INVALID',
            `Embedding provider returned an invalid vector at batch offset ${index}`,
            undefined,
            error,
          );
        }
      });
      const now = new Date().toISOString();
      const database = this.#database.connection;
      const transaction = database.transaction(() => {
        const statement = database.prepare(
          `INSERT INTO capability_embeddings(
             id, document_id, provider, model, dimensions, vector_json, vector_norm,
             content_sha256, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(document_id, provider, model) DO UPDATE SET
             dimensions = excluded.dimensions,
             vector_json = excluded.vector_json,
             vector_norm = excluded.vector_norm,
             content_sha256 = excluded.content_sha256,
             updated_at = excluded.updated_at`,
        );
        for (let index = 0; index < batch.length; index += 1) {
          const document = batch[index];
          const vector = validated[index];
          if (document === undefined || vector === undefined) {
            throw capabilityError('EMBEDDING_RESPONSE_INVALID', 'Embedding batch alignment failed');
          }
          statement.run(
            deterministicId('capability_embedding', `${document.id}:${providerName}:${model}`),
            document.id,
            providerName,
            model,
            dimensions,
            stableStringify(vector.values),
            vector.norm,
            document.contentHash,
            now,
            now,
          );
        }
      });
      transaction.immediate();
      indexed += batch.length;
    }
    return {
      projectId,
      provider: providerName,
      model,
      indexed,
      unchanged: counts.unchanged ?? 0,
    };
  }
}

export function validateVector(
  vector: unknown,
  dimensions: number,
): { readonly values: readonly number[]; readonly norm: number } {
  if (!Array.isArray(vector) || vector.length !== dimensions) {
    throw new RangeError(`Embedding vector must contain exactly ${dimensions} dimensions`);
  }
  let squaredNorm = 0;
  const values: number[] = [];
  for (const item of vector as readonly unknown[]) {
    if (typeof item !== 'number' || !Number.isFinite(item) || Math.abs(item) > 1_000_000) {
      throw new RangeError('Embedding values must be finite and within the supported range');
    }
    const normalized = Object.is(item, -0) ? 0 : item;
    squaredNorm += normalized * normalized;
    values.push(normalized);
  }
  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new RangeError('Embedding vector norm must be finite and non-zero');
  }
  return { values, norm };
}

function embeddingText(document: IndexDocumentRow): string {
  return `${document.name}\n${document.description}\n${document.searchText}`;
}

function assertProject(database: SqliteDatabase, projectId: string): void {
  const exists = database.connection
    .prepare('SELECT 1 AS present FROM projects WHERE id = ?')
    .get(projectId) as { readonly present: number } | undefined;
  if (exists === undefined) {
    throw capabilityError('CAPABILITY_PROJECT_NOT_FOUND', `Project does not exist: ${projectId}`);
  }
}
