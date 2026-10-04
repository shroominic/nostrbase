# Identity and access

Signatures establish authorship. Your app defines trust.

## Who can write

Table insert, upsert, update, and delete require a signer. The SDK checks author ownership. Reads include all authors by default; add `.author(pubkey)` for one author's collection.

Two users can create `task-1`. These are distinct records. Store both ID and author when referring to another record.

## Who can read

Public records, Broadcast payloads, Presence state, and index tags are public. A namespace does not protect them. Use [personal private tables](/docs/private-tables/) when the body should be readable only by its author.

Private records still reveal author, namespace, table, record ID, timestamps, and approximate size. Uploaded files are public unless your app encrypts the bytes before upload.

## Who is trusted

A valid signature proves that the key signed the event. It does not prove that the author is a moderator, that the data is true, or that a record belongs in your app's curated view.

Apply trusted-author lists or signed role records in the app. Client checks do not prevent another client from publishing an event. Use a controlled relay or service when a rule must govern storage or actions.

## Session and key lifecycle

The SDK keeps its signer session in memory and does not persist secret keys. Sign-out clears the session and stops private subscriptions and presence tracking. Your app owns key backup, signer teardown, and plaintext already placed in its UI.

An extension or remote signer lets the SDK request signatures without storing the user's key in the app. Direct-key signing is available for Node and development workflows.
