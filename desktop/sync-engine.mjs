import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { canonical, equal, hash, seal, unseal, mergeCommits } from './sync-core.mjs';

export async function atomic(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, file);
}
export class SyncEngine {
  constructor({ drive, state, save, directory, backend, changed }) {
    Object.assign(this, { drive, state, save, directory, backend, changed });
    this.status = { phase: 'disconnected', conflicts: [], lastSync: null, message: '' };
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
      !value.snapshot
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
  async sync(resolutions = {}, expectedHeads = null) {
    if (this.busy || !this.state.vault || !this.state.key || !this.drive) return;
    this.busy = true;
    this.status.phase = 'syncing';
    this.status.message = '';
    try {
      let local = await this.backend.get();
      let commits = await this.loadCommits();
      // Complete the metadata half of an interrupted apply before capturing new edits.
      if (this.state.pending) {
        const target = commits.find((c) => c.id === this.state.pending.id);
        if (target && equal(local.snapshot, target.snapshot)) {
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
        (previous && !equal(previous.snapshot, local.snapshot))
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
      if (!equal(merged.snapshot, local.snapshot)) {
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
      this.status.phase = 'synced';
      this.status.lastSync = new Date().toISOString();
    } catch (error) {
      this.status.phase = 'error';
      this.status.message = error.message;
    } finally {
      this.busy = false;
    }
  }
}
