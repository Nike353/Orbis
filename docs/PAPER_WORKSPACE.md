# Paper workspace

The paper workspace brings the original, generated summary, authored notes,
discussion, and connections into one reading view. See the
[user guide](USER_GUIDE.md) for the controls and [desktop guide](DESKTOP.md) for sync.

## Originals and evidence

PDFs and readable web articles are stored as immutable, content-addressed local
attachments. Portable metadata records their source and hash. Page extraction and
text-search indexes are rebuildable, device-local caches. Image-only PDFs need a
text version for retrieval; this preview does not add OCR.

Discussion and comparison retrieve bounded passages from available originals,
with page/section anchors checked against the selected source. The interface
reports notes-only fallback and incomplete coverage. A validated citation is not
a guarantee that an interpretation or numerical claim is correct.

A selected passage can become a highlight, comment, or discussion question.
Generated summaries retain the five-section structure, while personal notes and
conversation history remain distinct. Regenerating a summary creates a proposal
for review rather than silently overwriting it.

## Portable library, local device state

Google Drive sync includes original metadata, encrypted attachment blobs, saved
highlights/comments, notes, and conversations. Original bytes download on demand;
Keep offline retains a local copy. Remove download checks the remote copy before
removing local bytes and preserves the library's metadata and annotations.

Reading position, pending comment/question drafts, extraction caches, offline pins,
agent credentials, and running jobs remain device-local. Independent graphs keep
their content and queues separate. Never share credential files to move a library.

## Verification and remaining work

See [macOS verification](MAC_VERIFICATION.md) for the current tested build,
including a live original-backed Codex discussion, packaged native tests, and
existing-profile upgrade. Ubuntu native reader and Drive attachment checks were
performed during upstream development. This release has not been independently
security-audited, and not every model/provider or physical-device sync combination
has been tested. Signed/notarized distribution and automatic updates remain work.
