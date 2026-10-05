/**
 * Idempotency keys of documents that follow another one (2.52.1). The n-th receipt or credit of a document has one
 * key, fixed when its dialog opens: two devices issuing "the next one" at the same moment share it, and the database
 * keeps one document (unique business_id + idempotency_key); a retry from the same dialog keeps its key too.
 * A quote becomes one document, whoever converts it and however many times.
 */
export const followKey = (kind: 'receipt' | 'credit', documentId: string, existing: number) => `${kind}:${documentId}:${Math.max(0, existing) + 1}`;
export const quoteKey = (quoteId: string) => `quote:${quoteId}`;
