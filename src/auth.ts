import { ExtensionSigner, PrivateKeySigner } from "applesauce-signers";
import { asError, NostrbaseError } from "./errors";
import type { AuthChange, Result, Session, Signer, User } from "./types";

export class NostrbaseAuth {
  private signer: Signer | null = null;
  private session: Session | null = null;
  private generation = 0;
  get revision(): number {
    return this.generation;
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
    const generation = ++this.generation;
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
    this.generation++;
    this.initialization = null;
    this.signer = null;
    this.session = null;
    this.emit("SIGNED_OUT");
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
    void this.signOut();
  }
}
