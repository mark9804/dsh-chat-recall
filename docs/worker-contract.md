# v0.2 worker / Host contract

Worker is single-writer, JSONL serialized. No shared live store access from another worker.

`openStore({root, embedder?, candidatePolicy?, failureHook?})` -> async methods:

- `sync({session, messages, blocks})`: session = {sessionId,title,cwd,origin,createdAt,inheritedEventCount,cursor,anchorHash,updatedAt}; messages and blocks retain existing spike schemas (below), session.cursor>=-1. All rows belong to session and are tail rows or replay of same rows; immutable IDs, duplicate replay idempotent. Journal write then upsert messages/blocks, then checkpoint session last. Replay pending journals on open. failureHook(stage) only for tests, stages afterJournal/afterMessages/afterBlocks/afterCheckpoint. Reject changed content for existing same blockId or backward checkpoint with SOURCE_CHANGED. Reject reads after interrupted write until reopen recovery.
- `checkpoints({sessionIds?}={})` -> {sessions:[session rows]}; no wildcard arg needed.
- `embed({sessionIds})` -> process missing block chunks only, optional embedder; no auto embedding by sync; reply new/reused counts and remaining. No outbound plaintext audit in production. use paragraph-v1 chunker; stable chunkId include hash/version. Keep old cache vectors on model mismatch but refuse semantic ops EMBEDDING_CONFIG_CHANGED; exact/fuzzy still work.
- `search({query,mode,sessionIds,role?,from?,to?,limit?,cursor?,binding})` -> stable paginated {hits,nextCursor,totalCandidates,presentation,coverage,candidateTruncated}. sessionIds always explicit allowed list, []=none. Mode exact/fuzzy/semantic. On cursor, do not embed or rerank again, validate binding. Initial candidate pool bounded 1000 max and disclose cutoff. Semantic scope filtered BEFORE top-k, exact cosine in scope <=10000 chunks, ANN IVF_FLAT if above (index build once at growth threshold), rerank candidate vectors exact cosine; don't promise exhaustive ANN. Group duplicate inherited source via dedupKey, not equal text alone. Hit {ref:messageId,sessionId,eventSeq,blockIndex,role,time,textHash,excerpt,start,end,similarity? score? matchedTerms?}. excerpt is original substring max800 code units. top3 ref+similarity in presentation. Snapshots keep <=1000 original bounded hits. `chooseCandidates` and `SearchPages` modules under core as documented.
- `read({ref,blockIndex=0,offset=0,length=4000,before=1,after=1})` -> {ref,sessionId,eventSeq,blockIndex,role,time,text,textHash,offset,nextOffset,totalLength,context:[{ref,eventSeq,role,content:[bounded text or attachment refs]}]}; no source verification here (Host does). Block offsets cannot split surrogate; null text if attachment-only and context returned. Bounds length1..12000,before/after0..3.
- `sessions({sessionIds,query?,offset=0,limit=20})` -> paged indexed session metadata.
- `status()` -> counts, checkpoints or count, embedding space/status and pending count; no secrets.
- `close()`.

Messages from Host: {id:`sid:seq`, sessionId,title,cwd,origin,archived:false,eventSeq,time,role,contentJson}. contentJson array with text/image/file fields plus blockIndex,originalMessageId,inherited.
Blocks: {id:`sid:seq:blockIndex`,messageId,sessionId,origin,role,time,eventSeq,blockIndex,text}.
Backend adds textHash=SHA256 UTF8(text), dedupKey based on originalMessageId+role+blockIndex+hash when available else id. Existing block changes are errors, no silent rewriting. Context attachment-only messages count as messages.

Errors stable code: INVALID_REQUEST, NOT_FOUND, NOT_PREPARED, SOURCE_CHANGED, SYNC_INCOMPLETE, EMBEDDING_NOT_READY, EMBEDDING_CONFIG_CHANGED, NO_EMBEDDING_CONFIG, INVALID_RESPONSE, CURSOR_EXPIRED, INVALID_CURSOR, SEARCH_CAPACITY plus embedding adapter failures. Tools display no raw backend error text.

Initial installed profile restricted to explicit previously authorized session, no automatic all-profile embedding. Host sync emits separate metadata status; permission not determined by corpus existence.
