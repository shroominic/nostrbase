export const protocolDiagram = `<figure class="protocol-diagram" aria-label="The app calls nostrbase. The client requests signatures from an Applesauce signer, exchanges events with relays, and stores verified events in EventStore. Channels notify the app.">
<svg viewBox="0 0 680 310" role="img" aria-labelledby="stack-diagram-title">
<title id="stack-diagram-title">nostrbase SDK components</title>
<defs><marker id="stack-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="m1 1 6 3-6 3" fill="none" stroke="currentColor"/></marker></defs>
<g class="diagram-lines" fill="none" stroke="currentColor" stroke-width="1.2" marker-end="url(#stack-arrow)"><path d="M144 139h100"/><path d="M320 112V78"/><path d="M320 166v41"/><path d="M396 139h123" marker-start="url(#stack-arrow)"/><path d="M396 237h123"/><path d="M591 264v29H72V166"/></g>
<text x="459" y="125" text-anchor="middle" class="diagram-note">Nostr events</text>
<text x="139" y="284" class="diagram-note">Change callbacks</text>
<g class="diagram-node"><rect x="14" y="112" width="130" height="54" rx="7"/><text x="79" y="135" text-anchor="middle">Your app</text><text x="79" y="151" text-anchor="middle" class="diagram-note">UI and app rules</text></g>
<g class="diagram-node diagram-client"><rect x="244" y="112" width="152" height="54" rx="7"/><text x="320" y="135" text-anchor="middle">nostrbase</text><text x="320" y="151" text-anchor="middle" class="diagram-note">Applesauce transport</text></g>
<g class="diagram-node"><rect x="244" y="24" width="152" height="54" rx="7"/><text x="320" y="47" text-anchor="middle">Signer</text><text x="320" y="63" text-anchor="middle" class="diagram-note">Approve signatures</text></g>
<g class="diagram-node"><rect x="519" y="112" width="145" height="54" rx="7"/><text x="591" y="135" text-anchor="middle">Nostr relays</text><text x="591" y="151" text-anchor="middle" class="diagram-note">Store and deliver</text></g>
<g class="diagram-node"><rect x="244" y="207" width="152" height="57" rx="7"/><text x="320" y="233" text-anchor="middle">EventStore</text><text x="320" y="249" text-anchor="middle" class="diagram-note">Verified events</text></g>
<g class="diagram-node"><rect x="519" y="207" width="145" height="57" rx="7"/><text x="591" y="233" text-anchor="middle">Channels</text><text x="591" y="249" text-anchor="middle" class="diagram-note">Materialize changes</text></g>
</svg>
</figure>`;
