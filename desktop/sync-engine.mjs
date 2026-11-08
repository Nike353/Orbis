import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  canonical,
  hash,
  seal,
  unseal,
  mergeCommits,
  snapshotsEqual,
  sealOriginal,
  unsealOriginal,
  hashBytes,
} from './sync-core.mjs';

export async function atomic(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, file);
}
export class SyncEngine {
  constructor({ drive, state, save, directory, backend, changed }) {
    Object.assign(this, { drive, state, save, directory, backend, changed });
    this.status = {
      phase: state.syncError ? 'error' : 'disconnected',
      conflicts: [],
      lastSync: state.lastSync ?? null,
      message: state.syncError ?? '',
      nextRetry: state.nextRetry ?? null,
    };
    this.downloads = new Map();
  }
  async vaults() {
    return this.drive.list('vault');
  }
  async createVault() {
    const id = randomUUID(),
      key = randomBytes(32);
    await this.drive.create(
      'Orbis encrypted library',
      { orbisKind: 'vault', vault: id, protocol: '1' },
      seal({ version: 1, vault: id }, key, id),
    );
    this.state.vault = id;
    this.state.key = key.toString('base64url');
    this.state.lastCommit = null;
    await this.save();
    return this.state.key;
  }
  async unlock(fileId, keyText) {
    if (!/^[\w-]{43}$/.test(keyText))
      throw new Error('Enter the 43-character recovery key from your other device.');
    const vault = (await this.vaults()).find((v) => v.id === fileId);
    if (!vault || !/^[a-f0-9-]{36}$/.test(vault.appProperties.vault))
      throw new Error('Library not found');
    const id = vault.appProperties.vault;
    try {
      const check = unseal(
        await this.drive.download(fileId),
        Buffer.from(keyText, 'base64url'),
        id,
      );
      if (check.version !== 1 || check.vault !== id) throw new Error('Invalid library');
    } catch {
      throw new Error('The recovery key could not unlock this library.');
    }
    if (this.state.vault && this.state.vault !== id)
      throw new Error('This installation is already paired with another library.');
    this.state.vault = id;
    this.state.key = keyText;
    await this.save();
  }
  folder() {
    return path.join(this.directory, this.state.vault);
  }
  context(id) {
    return `orbis-v1:${this.state.vault}:${id}`;
  }
  originalContext(sha) {
    return `orbis-original-v1:${this.state.vault}:${sha}`;
  }
  originalRecords(snapshot) {
    return Object.entries(snapshot.graphs).flatMap(([graph, value]) =>
      Object.values(value.documents ?? {}).map((record) => ({ graph, ...record })),
    );
  }
  async remoteOriginals() {
    const files = await this.drive.list('original', this.state.vault),
      result = new Map();
    for (const file of files) {
      const sha = file.appProperties?.sha256;
      if (!/^[a-f0-9]{64}$/.test(sha) || file.appProperties.protocol !== '1')
        throw new Error('Unrecognized original file. Upgrade Orbis before syncing.');
      result.set(sha, [...(result.get(sha) ?? []), file]);
    }
    return result;
  }
  async verifiedOriginal(files, record) {
    let failure = new Error(
      'Original is missing from Drive. Retry sync on the device that has its local copy.',
    );
    for (const file of files ?? []) {
      try {
        const bytes = unsealOriginal(
          await this.drive.download(file.id),
          Buffer.from(this.state.key, 'base64url'),
          this.originalContext(record.sha256),
          record.sha256,
          record.size,
        );
        return { bytes, file };
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  }
  async uploadOriginals(snapshot) {
    const records = this.originalRecords(snapshot);
    if (!records.length) return;
    const available = (await this.backend.originals()).graphs,
      remote = await this.remoteOriginals();
    const groups = new Map();
    for (const record of records)
      groups.set(record.sha256, [...(groups.get(record.sha256) ?? []), record]);
    let count = 0;
    for (const [sha, group] of groups) {
      if (group.some((record) => record.size !== group[0].size))
        throw new Error('Original metadata has conflicting sizes. Files are preserved.');
      const local = group.find((record) => available[record.graph]?.[sha]?.available);
      const files = remote.get(sha) ?? [];
      const knownFile = files.find((file) =>
        group.some(
          (record) =>
            available[record.graph]?.[sha]?.remote_available &&
            available[record.graph][sha].remote_id === file.id,
        ),
      );
      let file = knownFile ?? files[0],
        verified = false;
      const known = Boolean(knownFile);
      const failed = group.some((record) =>
        ['error', 'interrupted'].includes(available[record.graph]?.[sha]?.transfer_status),
      );
      if (file && ((local && !known) || failed)) {
        try {
          file = (
            await this.verifiedOriginal(
              knownFile
                ? [knownFile, ...files.filter((candidate) => candidate !== knownFile)]
                : files,
              group[0],
            )
          ).file;
          verified = true;
        } catch (error) {
          if (!local) throw error;
          file = null; // Retain a corrupt remote copy and publish a verified replacement.
        }
      } else verified = known;
      if (!file) {
        if (!local) {
          const message =
            'An original has no local or Drive copy. Restore it before syncing; library edits are preserved.';
          for (const record of group)
            await this.backend.originalState(record.graph, sha, {
              transfer_status: 'error',
              transfer_error: message,
              remote_available: false,
            });
          throw new Error(message);
        }
        this.status.message = `Uploading original ${++count} of ${groups.size}…`;
        for (const record of group)
          await this.backend.originalState(record.graph, sha, {
            transfer_status: 'uploading',
            transfer_error: '',
            remote_available: false,
          });
        try {
          const content = await this.backend.readOriginal(local.graph, sha);
          if (hashBytes(content) !== sha || content.length !== local.size)
            throw new Error('Local original failed its integrity check; upload stopped');
          const created = await this.drive.create(
            `${sha}.original`,
            { orbisKind: 'original', vault: this.state.vault, sha256: sha, protocol: '1' },
            sealOriginal(
              content,
              Buffer.from(this.state.key, 'base64url'),
              this.originalContext(sha),
            ),
          );
          file = { ...created, appProperties: { sha256: sha, protocol: '1' } };
          remote.set(sha, [...(remote.get(sha) ?? []), file]);
          verified = true;
        } catch (error) {
          for (const record of group)
            await this.backend.originalState(record.graph, sha, {
              transfer_status: 'error',
              transfer_error: error.message,
              remote_available: false,
            });
          throw error;
        }
      }
      for (const record of group) {
        const entry = available[record.graph]?.[sha] ?? {};
        const update = {
          remote_id: file.id,
          remote_available: verified,
          transfer_status: entry.available ? 'uploaded' : 'available_on_drive',
          transfer_error: '',
        };
        if (Object.entries(update).some(([key, value]) => entry[key] !== value))
          await this.backend.originalState(record.graph, sha, update);
      }
    }
  }
  async downloadOriginal(graph, record, files = null) {
    if (!this.drive || !this.state.key || !this.state.vault)
      throw new Error('Connect and unlock Google Drive to download originals.');
    const id = `${graph}:${record.sha256}`;
    if (this.downloads.has(id)) return this.downloads.get(id);
    const transfer = (async () => {
      try {
        await this.backend.originalState(graph, record.sha256, {
          transfer_status: 'downloading',
          transfer_error: '',
        });
        const { bytes, file } = await this.verifiedOriginal(
          (files ?? (await this.remoteOriginals())).get(record.sha256),
          record,
        );
        await this.backend.writeOriginal(graph, record.sha256, bytes);
        await this.backend.originalState(graph, record.sha256, {
          transfer_status: 'downloaded',
          transfer_error: '',
          remote_available: true,
          remote_id: file.id,
        });
        this.changed();
      } catch (error) {
        await this.backend.originalState(graph, record.sha256, {
          transfer_status: 'error',
          transfer_error: error.message,
          remote_available: false,
        });
        throw error;
      } finally {
        this.downloads.delete(id);
      }
    })();
    this.downloads.set(id, transfer);
    return transfer;
  }
  async downloadPinned(snapshot) {
    const records = this.originalRecords(snapshot);
    if (!records.length) return;
    const available = (await this.backend.originals()).graphs;
    const pending = records.filter((record) => {
      const entry = available[record.graph]?.[record.sha256];
      return entry?.keep_offline && !entry.available;
    });
    if (!pending.length) return;
    const files = await this.remoteOriginals();
    for (const record of pending) await this.downloadOriginal(record.graph, record, files);
  }
  async confirmRemoteOriginal(graph, record) {
    if (!this.drive || !this.state.key || !this.state.vault)
      throw new Error('Connect Google Drive before removing a local original.');
    try {
      const { file } = await this.verifiedOriginal(
        (await this.remoteOriginals()).get(record.sha256),
        record,
      );
      await this.backend.originalState(graph, record.sha256, {
        remote_available: true,
        remote_id: file.id,
        transfer_error: '',
        transfer_status: 'uploaded',
      });
    } catch (error) {
      await this.backend.originalState(graph, record.sha256, {
        remote_available: false,
        transfer_error: error.message,
        transfer_status: 'error',
      });
      throw error;
    }
  }
  async loadCommits() {
    await mkdir(this.folder(), { recursive: true, mode: 0o700 });
    const commits = [];
    for (const name of await readdir(this.folder()))
      if (/^[a-f0-9]{64}\.bin$/.test(name)) {
        commits.push(
          this.decode(await readFile(path.join(this.folder(), name)), name.slice(0, -4)),
        );
      }
    return commits;
  }
  decode(bytes, id) {
    const value = unseal(bytes, Buffer.from(this.state.key, 'base64url'), this.context(id));
    if (
      hash(value) !== id ||
      value.version !== 1 ||
      !Array.isArray(value.parents) ||
      value.parents.some((p) => !/^[a-f0-9]{64}$/.test(p)) ||
      !value.snapshot ||
      ![1, 2].includes(value.snapshot.version)
    )
      throw new Error('Invalid sync commit');
    return { ...value, id };
  }
  async commit(snapshot, parents) {
    const value = {
      version: 1,
      parents: [...new Set(parents)].sort(),
      snapshot,
      device: this.state.device,
      created: new Date().toISOString(),
    };
    const id = hash(value),
      bytes = seal(value, Buffer.from(this.state.key, 'base64url'), this.context(id));
    await atomic(path.join(this.folder(), `${id}.bin`), bytes);
    return { ...value, id };
  }
  async sync(resolutions = {}, expectedHeads = null, automatic = false) {
    if (this.busy || !this.state.vault || !this.state.key || !this.drive) return;
    if (automatic && Date.now() < (this.state.nextRetry ?? 0)) return;
    this.busy = true;
    this.status.phase = 'syncing';
    this.status.message = '';
    try {
      let local = await this.backend.get();
      let commits = await this.loadCommits();
      // Complete the metadata half of an interrupted apply before capturing new edits.
      if (this.state.pending) {
        const target = commits.find((c) => c.id === this.state.pending.id);
        if (target && snapshotsEqual(local.snapshot, target.snapshot)) {
          this.state.lastCommit = target.id;
        } else if (target && this.state.pending.createdLocally) {
          // A failed/CAS-rejected merge is not an accepted edit. Never publish it.
          await unlink(path.join(this.folder(), `${target.id}.bin`));
          commits = commits.filter((c) => c.id !== target.id);
        }
        this.state.pending = null;
        await this.save();
      }
      const previous = commits.find((c) => c.id === this.state.lastCommit);
      if (this.state.lastCommit && !previous)
        throw new Error('Local sync history is missing. Restore it before syncing.');
      await this.uploadOriginals(local.snapshot);
      const empty =
        Object.values(local.snapshot.graphs).every(
          (g) =>
            !Object.keys(g.nodes).length &&
            !Object.keys(g.sessions).length &&
            !Object.keys(g.notes).length,
        ) && Object.keys(local.snapshot.graphs).length === 1;
      // An empty installation joins the remote history without inventing a competing root.
      if (
        (!previous && !empty) ||
        (previous && !snapshotsEqual(previous.snapshot, local.snapshot))
      ) {
        const commit = await this.commit(local.snapshot, previous ? [previous.id] : []);
        commits.push(commit);
        this.state.lastCommit = commit.id;
        await this.save();
      }
      const files = await this.drive.list('commit', this.state.vault);
      const remote = new Set();
      for (const file of files) {
        const id = file.appProperties?.commit;
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Unrecognized sync file');
        remote.add(id);
        if (!commits.some((c) => c.id === id)) {
          const bytes = await this.drive.download(file.id),
            c = this.decode(bytes, id);
          await atomic(path.join(this.folder(), `${id}.bin`), bytes);
          commits.push(c);
        }
      }
      if (!commits.length) {
        const c = await this.commit(local.snapshot, []);
        commits.push(c);
        this.state.lastCommit = c.id;
        await this.save();
      }
      // Publish immutable commits. Interrupted uploads can duplicate a file but not an edit.
      for (const c of commits)
        if (!remote.has(c.id)) {
          await this.drive.create(
            `${c.id}.bin`,
            { orbisKind: 'commit', vault: this.state.vault, commit: c.id },
            await readFile(path.join(this.folder(), `${c.id}.bin`)),
          );
        }
      let merged = mergeCommits(commits);
      if (expectedHeads && canonical(expectedHeads) !== canonical(merged.heads))
        throw new Error(
          'New changes arrived. Review the refreshed conflicts before resolving.',
        );
      if (Object.keys(resolutions).length) merged = mergeCommits(commits, resolutions);
      this.status.heads = merged.heads;
      this.status.conflicts = merged.conflicts;
      if (merged.conflicts.length) {
        this.status.phase = 'conflict';
        return;
      }
      if (!snapshotsEqual(merged.snapshot, local.snapshot)) {
        // CAS rejects a save or agent result that arrived while Drive was being contacted.
        const target =
          merged.heads.length === 1
            ? commits.find((c) => c.id === merged.heads[0])
            : await this.commit(merged.snapshot, merged.heads);
        this.state.pending = { id: target.id, createdLocally: merged.heads.length > 1 };
        await this.save();
        await this.backend.apply(merged.snapshot, local.digest);
        this.state.lastCommit = target.id;
        this.state.pending = null;
        await this.save();
        this.changed();
      } else if (merged.heads.length > 1) {
        const target = await this.commit(merged.snapshot, merged.heads);
        this.state.lastCommit = target.id;
        await this.save();
      } else {
        this.state.lastCommit = merged.heads[0];
        await this.save();
      }
      // Ensure an explicit conflict resolution/merge is available to the other laptop now.
      const id = this.state.lastCommit;
      if (!remote.has(id) && !commits.some((c) => c.id === id))
        await this.drive.create(
          `${id}.bin`,
          { orbisKind: 'commit', vault: this.state.vault, commit: id },
          await readFile(path.join(this.folder(), `${id}.bin`)),
        );
      await this.uploadOriginals(merged.snapshot);
      await this.downloadPinned(merged.snapshot);
      this.status.phase = 'synced';
      this.status.lastSync = new Date().toISOString();
      this.status.message = '';
      this.state.lastSync = this.status.lastSync;
      this.state.syncError = '';
      this.state.syncFailures = 0;
      this.state.nextRetry = null;
      this.status.nextRetry = null;
      await this.save();
    } catch (error) {
      this.status.phase = 'error';
      this.status.message = error.message;
      this.state.syncError = error.message;
      this.state.syncFailures = Math.min(6, (this.state.syncFailures ?? 0) + 1);
      this.state.nextRetry =
        Date.now() + Math.min(600000, 10000 * 2 ** this.state.syncFailures);
      this.status.nextRetry = this.state.nextRetry;
      try {
        await this.save();
      } catch (saveError) {
        this.status.message += ` Local sync state could not be saved: ${saveError.message}`;
      }
    } finally {
      this.busy = false;
    }
  }
}
