import { ExtensionSigner, PrivateKeySigner } from "applesauce-signers";
import { getPublicKey } from "nostr-tools";
import { asError, NostrbaseError } from "./errors";
import type { KeyDecryptionOptions, KeyEncryptionOptions } from "./key-backup";
import { decryptKey, encryptKey } from "./key-backup";
import type { AuthChange, Result, Session, Signer, User } from "./types";

export class NostrbaseAuth {
  private signer: Signer | null = null;
  private session: Session | null = null;
  private generation = 0;
  private revisionController = new AbortController();
  private settled = true;
  private settledListeners = new Set<() => void>();
  get revision(): number {
    return this.generation;
  }
  /** Replaced on every auth revision. The previous signal aborts before pending sign-in work. */
  get revisionSignal(): AbortSignal {
    return this.revisionController.signal;
  }
  /** @internal True when the current auth transition has completed, including failed sign-in. */
  get revisionSettled(): boolean {
    return this.settled;
  }
  /** @internal Observe completed auth transitions without emitting a public successful sign-in. */
  onRevisionSettled(callback: () => void): { unsubscribe(): void } {
    if (this.closed) throw new NostrbaseError("CLIENT_CLOSED", "Client is closed.");
    this.settledListeners.add(callback);
    return { unsubscribe: () => this.settledListeners.delete(callback) };
  }
  private advance(): number {
    const generation = ++this.generation;
    this.settled = false;
    const previous = this.revisionController;
    this.revisionController = new AbortController();
    previous.abort();
    if (this.closed) this.revisionController.abort();
    return generation;
  }
  private settle(generation: number): void {
    if (this.closed || generation !== this.generation) return;
    this.settled = true;
    for (const listener of this.settledListeners) {
      try {
        listener();
      } catch {
        /* Observer errors must not change auth state. */
      }
    }
  }
  private closed = false;
  private listeners = new Set<(event: AuthChange, session: Session | null) => void>();
  private initialization: Promise<Result<Session>> | null;
  constructor(signer?: Signer) {
    this.initialization = signer ? this.signInWithSigner(signer) : null;
  }
  private emit(event: AuthChange): void {
    for (const listener of this.listeners) {
      try {
        listener(event, this.session);
      } catch {
        /* Observer errors must not change auth state. */
      }
    }
  }
  async signInWithSigner(signer: Signer): Promise<Result<Session>> {
    const generation = this.advance();
    try {
      if (this.closed) throw new NostrbaseError("CLIENT_CLOSED", "Client is closed.");
      const pubkey = await signer.getPublicKey();
      if (!/^[0-9a-f]{64}$/.test(pubkey))
        throw new NostrbaseError("AUTH_FAILED", "Signer returned an invalid public key.");
      if (generation !== this.generation)
        throw new NostrbaseError("AUTH_FAILED", "Sign-in was superseded.");
      this.signer = signer;
      this.session = Object.freeze({ user: Object.freeze({ id: pubkey, pubkey }) });
      this.initialization = null;
      this.emit("SIGNED_IN");
      return { data: this.session, error: null };
    } catch (error) {
      return { data: null, error: asError(error, "AUTH_FAILED") };
    } finally {
      this.settle(generation);
    }
  }
  signInWithExtension(): Promise<Result<Session>> {
    return this.signInWithSigner(new ExtensionSigner());
  }
  async signInWithPrivateKey(key: Uint8Array | string): Promise<Result<Session>> {
    try {
      return await this.signInWithSigner(PrivateKeySigner.fromKey(key));
    } catch (error) {
      return { data: null, error: asError(error, "AUTH_FAILED") };
    }
  }
  private checkKeyOperation(generation: number, signal?: AbortSignal): void {
    if (this.closed) throw new NostrbaseError("CLIENT_CLOSED", "Client is closed.");
    if (generation !== this.generation)
      throw new NostrbaseError("AUTH_FAILED", "Key operation was superseded.");
    if (signal?.aborted) throw new NostrbaseError("ABORTED", "Key operation was aborted.");
  }
  private keyError(error: unknown): NostrbaseError {
    if (error instanceof NostrbaseError) {
      if (error.code === "CLIENT_CLOSED")
        return new NostrbaseError("CLIENT_CLOSED", "Client is closed.");
      if (error.code === "ABORTED")
        return new NostrbaseError("ABORTED", "Key operation was aborted.");
      if (error.code === "AUTH_REQUIRED")
        return new NostrbaseError("AUTH_REQUIRED", "Sign in before exporting a private key.");
      if (error.code === "PERMISSION_DENIED")
        return new NostrbaseError(
          "PERMISSION_DENIED",
          "This signer does not support private key export.",
        );
    }
    return new NostrbaseError(
      "AUTH_FAILED",
      "Key operation failed or the active identity changed.",
    );
  }
  private exportBinding(
    signer: PrivateKeySigner,
    account: string,
    generation: number,
    signal?: AbortSignal,
  ): void {
    this.checkKeyOperation(generation, signal);
    if (
      this.signer !== signer ||
      this.session?.user.pubkey !== account ||
      !(signer.key instanceof Uint8Array) ||
      signer.key.length !== 32 ||
      getPublicKey(signer.key) !== account
    )
      throw new NostrbaseError("AUTH_FAILED", "The active private key changed.");
  }
  /** Export only a password-encrypted NIP-49 key from the active local PrivateKeySigner. */
  async exportKey(password: string, options: KeyEncryptionOptions = {}): Promise<Result<string>> {
    let key: Uint8Array | undefined;
    try {
      const generation = this.generation;
      this.checkKeyOperation(generation, options?.signal);
      const { signer, session } = await this.requireSigner();
      this.checkKeyOperation(generation, options?.signal);
      if (!(signer instanceof PrivateKeySigner))
        throw new NostrbaseError(
          "PERMISSION_DENIED",
          "This signer does not support private key export.",
        );
      const account = session.user.pubkey;
      this.exportBinding(signer, account, generation, options?.signal);
      key = new Uint8Array(signer.key);
      if (getPublicKey(key) !== account)
        throw new NostrbaseError("AUTH_FAILED", "The active private key changed.");
      const result = await encryptKey(key, password, options);
      this.exportBinding(signer, account, generation, options?.signal);
      return result;
    } catch (error) {
      return { data: null, error: this.keyError(error) };
    } finally {
      key?.fill(0);
    }
  }
  /** Recover a local signer from a password-encrypted NIP-49 key without exposing raw bytes. */
  async signInWithEncryptedKey(
    ncryptsec: string,
    password: string,
    options: KeyDecryptionOptions = {},
  ): Promise<Result<Session>> {
    const generation = this.advance();
    let key: Uint8Array | undefined;
    let signer: PrivateKeySigner | undefined;
    try {
      this.checkKeyOperation(generation, options?.signal);
      const decrypted = await decryptKey(ncryptsec, password, options);
      key = decrypted.data ?? undefined;
      this.checkKeyOperation(generation, options?.signal);
      if (decrypted.error) return { data: null, error: decrypted.error };
      if (!key) throw new NostrbaseError("AUTH_FAILED", "Private key recovery failed.");
      signer = new PrivateKeySigner(new Uint8Array(key));
      const pubkey = await signer.getPublicKey();
      this.checkKeyOperation(generation, options?.signal);
      if (!/^[0-9a-f]{64}$/.test(pubkey) || getPublicKey(signer.key) !== pubkey)
        throw new NostrbaseError("AUTH_FAILED", "Private key recovery failed.");
      this.signer = signer;
      this.session = Object.freeze({ user: Object.freeze({ id: pubkey, pubkey }) });
      this.initialization = null;
      this.emit("SIGNED_IN");
      return { data: this.session, error: null };
    } catch (error) {
      return { data: null, error: this.keyError(error) };
    } finally {
      key?.fill(0);
      if (signer && this.signer !== signer) signer.key.fill(0);
      this.settle(generation);
    }
  }
  async getSession(): Promise<Result<Session>> {
    if (this.initialization) {
      const result = await this.initialization;
      this.initialization = null;
      if (result.error) return result;
    }
    return { data: this.session, error: null };
  }
  async getUser(): Promise<Result<User>> {
    const result = await this.getSession();
    return { data: result.data?.user ?? null, error: result.error };
  }
  async signOut(): Promise<Result<null>> {
    const generation = this.advance();
    this.initialization = null;
    this.signer = null;
    this.session = null;
    this.emit("SIGNED_OUT");
    this.settle(generation);
    return { data: null, error: null };
  }
  onAuthStateChange(callback: (event: AuthChange, session: Session | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  } {
    if (this.closed) throw new NostrbaseError("CLIENT_CLOSED", "Client is closed.");
    this.listeners.add(callback);
    void this.getSession().then(() => {
      if (this.listeners.has(callback)) {
        try {
          callback("INITIAL_SESSION", this.session);
        } catch {
          /* Isolate observers. */
        }
      }
    });
    return { data: { subscription: { unsubscribe: () => this.listeners.delete(callback) } } };
  }
  async requireSigner(): Promise<{ signer: Signer; session: Session }> {
    const result = await this.getSession();
    if (result.error) throw result.error;
    if (!this.signer || !this.session)
      throw new NostrbaseError("AUTH_REQUIRED", "Sign in with a Nostr signer before writing.");
    return { signer: this.signer, session: this.session };
  }
  dispose(): void {
    this.closed = true;
    this.listeners.clear();
    this.settledListeners.clear();
    void this.signOut();
  }
}
