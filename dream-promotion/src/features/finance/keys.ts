/**
 * Idempotency keys of documents that follow another one (2.52.1). The n-th receipt or credit of a document has one
 * key, fixed when its dialog opens: two devices issuing "the next one" at the same moment share it, and the database
 * keeps one document (unique business_id + idempotency_key); a retry from the same dialog keeps its key too.
 * A quote becomes one document, whoever converts it and however many times.
 */
export const followKey = (kind: 'receipt' | 'credit' | 'from' | 'refund', documentId: string, existing: number) => `${kind}:${documentId}:${Math.max(0, existing) + 1}`;
/* 2.95: "from" — the n-th document made from an order or a delivery note (a delivery note, an invoice, a return note) */
/* 2.118: "refund" — the n-th refund receipt (an exempt dealer's 400 below zero) on a receipt, from the money screens. Never the
   same as a register / order refund's key (refund:<sale_refunds.id> — one part after "refund:", this one two). */
export const quoteKey = (quoteId: string) => `quote:${quoteId}`;
