import { type BlobDescriptor, NostrConnectSigner, PrivateKeySigner, scopeTag } from "nostrbase";
import { type Note, type Project, type Task, Workspace } from "./workspace";
import "./style.css";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
const params = new URLSearchParams(location.search);
const config = {
  relay: params.get("relay") ?? "ws://127.0.0.1:18047",
  blossom: params.get("blossom") ?? "http://127.0.0.1:18047",
  namespace: params.get("workspace") ?? "com.example.fieldwork",
};
element("app").innerHTML = `
  <aside class="sidebar">
    <a class="brand" href="/" aria-label="Fieldwork home"><span class="brand-mark">f.</span>fieldwork<span class="brand-dot">®</span></a>
    <div class="workspace-label"><span class="avatar">F</span><div>Open workspace<small>Built on Nostr</small></div><span class="chevron">↗</span></div>
    <p class="eyebrow">WORKSPACE</p>
    <nav aria-label="Workspace pages">
      <button data-view="board" aria-current="page"><span aria-hidden="true">▦</span>Project board</button>
      <button data-view="notes"><span aria-hidden="true">▤</span>Private notebook<span class="tiny-badge">NIP-44</span></button>
      <button data-view="files"><span aria-hidden="true">↥</span>Files</button>
      <button data-view="tools"><span aria-hidden="true">⌘</span>Developer console</button>
    </nav>
    <div class="project-heading"><p class="eyebrow">PROJECTS</p><button id="new-project" class="icon-button" aria-label="New project">+</button></div>
    <div id="projects" class="project-list"></div>
    <div class="sidebar-bottom"><span class="connection-dot"></span><span id="network-label">Online</span><small>Client + relay. Your keys.</small></div>
  </aside>
  <main>
    <header class="topbar"><div class="breadcrumb">Workspace <span>/</span> <strong id="page-name">Project board</strong></div><div class="header-actions"><span id="presence" class="presence">0 here</span><button id="identity" class="identity">Connect identity ↗</button></div></header>
    <div class="content">
      <div id="notice" role="status" aria-live="polite">Connect an identity to create your first project.</div>
      <section id="board" class="view">
        <div class="page-heading"><div><p class="eyebrow">A LITTLE STRUCTURE. A LOT OF POSSIBILITY.</p><h1 id="project-title">Make room for good work.</h1><p id="project-description" class="subtitle">An open workspace for ideas that deserve to happen.</p></div><button id="sample" class="button secondary">Load sample project ↗</button></div>
        <div class="board-toolbar"><div class="view-label">▦ <strong>Board view</strong><span id="task-count">0 tasks loaded</span></div><div class="toolbar-actions"><label class="search-label"><span>⌕</span><input id="search" aria-label="Search tasks" placeholder="Search tasks…"></label><label class="queue-toggle"><input id="queue" type="checkbox">Queue writes</label><button id="refresh" class="button secondary">Refresh</button></div></div>
        <form id="task-form" class="task-form"><input id="task-title" aria-label="Task title" placeholder="What needs to happen?" maxlength="160" required><select id="task-priority" aria-label="Priority"><option value="normal">Normal priority</option><option value="high">High priority</option></select><button class="button" type="submit">+ Add task</button></form>
        <div class="kanban">${[
          ["planned", "Planned", "muted"],
          ["active", "In progress", "orange"],
          ["done", "Done", "green"],
        ]
          .map(
            ([status, label, color]) =>
              `<section class="column" aria-label="${label}"><h2><span class="status-dot ${color}"></span>${label}<span id="count-${status}" class="column-count">0</span></h2><div id="tasks-${status}" class="cards"></div></section>`,
          )
          .join("")}</div>
        <button id="more" class="button secondary load-more" hidden>Load more tasks</button>
        <div class="board-footer"><span>Small steps, shared openly.</span><span>Signed records · author-owned edits</span></div>
        <section class="activity-strip"><div><p class="eyebrow">LIVE ROOM</p><p id="signal" aria-live="polite">Send a small update to everyone here.</p></div><form id="signal-form"><input id="signal-text" aria-label="Room update" placeholder="A quick update…" maxlength="200" required><button class="button secondary">Send update ↗</button></form></section>
      </section>
      <section id="notes" class="view" hidden><div class="page-heading"><div><p class="eyebrow">FOR YOUR EYES</p><h1>A place to think.</h1><p class="subtitle">Encrypted personal notes. Other identities cannot read them.</p></div><span class="feature-chip">NIP-44 encrypted</span></div><form id="note-form" class="panel note-form"><label>Note title<input id="note-title" maxlength="100" required></label><label>Your note<textarea id="note-body" maxlength="4000" required placeholder="Keep a thought for later…"></textarea></label><button class="button">Save private note</button></form><div id="note-list" class="note-grid"></div></section>
      <section id="files" class="view" hidden><div class="page-heading"><div><p class="eyebrow">BRING THE DETAILS</p><h1>Files with a fingerprint.</h1><p class="subtitle">Public Blossom files, verified by SHA-256. Attach files from a task.</p></div><button id="list-files" class="button secondary">Refresh files</button></div><div id="file-list" class="file-list panel"></div></section>
      <section id="tools" class="view" hidden><div class="page-heading"><div><p class="eyebrow">UNDER THE SURFACE</p><h1>Your workspace, inspected.</h1><p class="subtitle">Actual SDK operations, relay receipts, and local state.</p></div><span class="feature-chip">nostrbase 0.2</span></div>
        <div class="tools-grid"><section class="panel"><h2>Delivery & recovery</h2><p>Queued writes stay on this device until you replay them.</p><p id="pending">0 pending writes</p><div class="button-row"><button id="flush" class="button">Replay queued writes</button><button id="sync" class="button secondary">Recover from relay</button><button id="query-sync" class="button secondary">Recover with REQ</button><button id="pause-live" class="button secondary">Pause live updates</button></div><pre id="sync-result">No recovery run yet.</pre><p id="capabilities">Reading relay capabilities…</p><form id="native-search-form"><label>NIP-50 event search<input id="native-search" placeholder="Search public events"></label><button id="native-search-button" class="button secondary" disabled>Search relay</button></form></section>
        <section class="panel"><h2>Record migration</h2><p>Upgrade your tasks to revision 2. Preview before applying.</p><div class="button-row"><button id="preview-migration" class="button secondary">Preview migration</button><button id="apply-migration" class="button" disabled>Apply migration</button></div><pre id="migration-result">No preview yet.</pre></section>
        <section class="panel"><h2>Signed backup</h2><p>Private notes remain ciphertext. Import restores the local cache.</p><div class="button-row"><button id="export" class="button secondary">Export backup</button><button id="import" class="button secondary">Import backup</button><button id="download-backup" class="button secondary">Download JSON</button></div><textarea id="backup" aria-label="Signed backup" placeholder="Export or paste a backup here."></textarea></section>
        <section class="panel"><h2>Native Nostr profile</h2><p>Publish a kind-0 profile using the same signer.</p><form id="profile-form"><label>Display name<input id="profile-name" maxlength="80" required></label><button class="button secondary">Publish profile</button></form><button id="read-profile" class="button secondary">Read profile</button><pre id="profile-result">No profile loaded.</pre><form id="public-update-form"><label>Public activity message<input id="public-update" maxlength="200" required></label><button class="button secondary">Publish public update</button></form></section></div>
        <details class="panel"><summary>Local cache inspector</summary><div id="inspector"></div></details>
        <section class="panel operations"><h2>Operation log</h2><p>Relay acknowledgements describe this attempt. They do not prove permanent storage.</p><div id="operations"></div></section>
      </section>
      <footer class="content-footer"><span>FIELDWORK / AN EXAMPLE BUILT WITH NOSTRBASE</span><span>Local development services · ${escapeHtml(config.namespace)}</span></footer>
    </div>
  </main>
  <dialog id="identity-dialog"><form id="identity-form"><div class="dialog-heading"><p class="eyebrow">YOUR KEYS. YOUR WORK.</p><button type="button" class="close-dialog" aria-label="Close identity">×</button></div><h2>Connect an identity.</h2><p>Use your Nostr extension for a user-controlled identity.</p><label>Display name<input id="display-name" value="Explorer" maxlength="80" required></label><button id="extension" type="button" class="button">Connect Nostr extension</button><div class="divider">LOCAL DEVELOPMENT</div><p>A demo key is stored in this tab's session storage. Do not use it for valuable data.</p><button id="demo" type="button" class="button secondary">Use demo identity</button><label>Bunker URI<input id="bunker" placeholder="bunker://…"></label><button id="remote" type="button" class="button secondary">Connect remote signer</button><button id="signout" type="button" class="button danger">Sign out</button><p id="public-key" class="key"></p></form></dialog>
  <dialog id="project-dialog"><form id="project-form"><div class="dialog-heading"><p class="eyebrow">A NEW BEGINNING</p><button type="button" class="close-dialog" aria-label="Close project">×</button></div><h2>Create a project.</h2><label>Project name<input id="new-project-title" maxlength="100" required></label><label>Description<textarea id="new-project-description" maxlength="500"></textarea></label><button class="button">Create project</button></form></dialog>
  <dialog id="task-dialog"><div class="dialog-heading"><p class="eyebrow">TASK DETAILS</p><button type="button" class="close-dialog" aria-label="Close task">×</button></div><h2 id="detail-title"></h2><p id="detail-project"></p><p id="detail-author" class="key"></p><form id="edit-task-form"><label>Task name<input id="edit-task-title" maxlength="160" required></label><label>Status<select id="edit-task-status"><option value="planned">Planned</option><option value="active">In progress</option><option value="done">Done</option></select></label><button id="save-task" class="button">Save changes</button></form><label class="upload-label">Attach public file<input id="attachment" type="file"></label><div id="task-attachment"></div><div class="dialog-footer"><span id="detail-revision"></span><button id="delete-task" class="button danger">Delete task</button></div></dialog>
`;

let project: Project | undefined;
let projects: Project[] = [];
let tasks: Task[] = [];
let selected: Task | undefined;
let notes: Note[] = [];
let author = "";
let cursor: string | undefined;
let actionTail = Promise.resolve();
let refreshGeneration = 0;
let livePaused = false;
const demoStorageKey = `fieldwork:demo:${config.namespace}`;
const workspace = new Workspace(config, () => renderOperations());
const db = workspace.db;
let remoteSigner: NostrConnectSigner | undefined;
let inspector: ReturnType<typeof db.dashboard.mount> | undefined;
const queueWrites = () => element<HTMLInputElement>("queue").checked || !navigator.onLine;
const tell = (message: string, error = false) => {
  element("notice").textContent = message;
  element("notice").classList.toggle("error", error);
};
function action(id: string, run: () => Promise<void>, event = "click") {
  element(id).addEventListener(event, (e) => {
    e.preventDefault();
    if (element(id).getAttribute("aria-busy") === "true") return;
    element(id).setAttribute("aria-busy", "true");
    renderPaging();
    // Serialize user actions. A slow operation must not silently drop the next click.
    actionTail = actionTail.then(async () => {
      try {
        await run();
      } catch (error) {
        tell(error instanceof Error ? error.message : String(error), true);
      } finally {
        element(id).removeAttribute("aria-busy");
        renderPaging();
        await renderPending().catch(() => {});
      }
    });
  });
}
function renderOperations() {
  element("operations").innerHTML = workspace.operations
    .map(
      (operation) =>
        `<details class="operation ${operation.error ? "failed" : ""}"><summary><span>${escapeHtml(operation.label)}</span><small>${escapeHtml(operation.time)} · ${operation.error ? "Error" : "Complete"}</small></summary>${operation.error ? `<p>${escapeHtml(operation.error)}</p>` : ""}<pre>${escapeHtml(JSON.stringify(operation.meta, null, 2))}</pre></details>`,
    )
    .join("");
}
async function renderPending() {
  element("pending").textContent = `${(await db.offline.list()).length} pending writes`;
  await inspector?.refresh();
}
function renderPaging() {
  const more = element<HTMLButtonElement>("more");
  more.hidden = !cursor;
  // Sample writes can move the button before the pointer click completes.
  more.disabled = ["sample", "more"].some((id) => element(id).getAttribute("aria-busy") === "true");
}
function renderBoard() {
  element("project-title").textContent = project?.title ?? "Make room for good work.";
  element("project-description").textContent =
    project?.description ?? "An open workspace for ideas that deserve to happen.";
  element("projects").innerHTML = projects
    .map(
      (item) =>
        `<button data-project="${escapeHtml(item.id)}" data-author="${item._nostr.pubkey}" class="${project?.id === item.id && project?._nostr.pubkey === item._nostr.pubkey ? "selected" : ""}"><span class="project-swatch"></span>${escapeHtml(item.title)}</button>`,
    )
    .join("");
  for (const status of ["planned", "active", "done"]) {
    const rows = tasks.filter((task) => task.status === status);
    element(`count-${status}`).textContent = String(rows.length);
    element(`tasks-${status}`).innerHTML =
      rows
        .map(
          (task) =>
            `<button class="task-card" data-task="${escapeHtml(task.id)}" data-author="${task._nostr.pubkey}"><span class="task-top"><span class="task-id">FW / ${task.id.slice(0, 5).toUpperCase()}</span><span class="priority ${task.priority}">${task.priority === "high" ? "↑ High" : "Normal"}</span></span><strong>${escapeHtml(task.title)}</strong><span class="task-bottom"><span>${task.attachment ? "↥ 1 file" : "○ No attachment"}</span><span class="author-avatar" title="${task._nostr.pubkey}">${task._nostr.pubkey === author ? "ME" : task._nostr.pubkey.slice(0, 2).toUpperCase()}</span></span></button>`,
        )
        .join("") ||
      '<div class="empty-column">A little breathing room.<br><small>Tasks will appear here.</small></div>';
  }
  element("task-count").textContent = `${tasks.length} tasks loaded`;
  renderPaging();
  element<HTMLButtonElement>("sample").disabled = !author;
  element<HTMLButtonElement>("new-project").disabled = !author;
  for (const input of element<HTMLFormElement>("task-form").querySelectorAll<
    HTMLInputElement | HTMLButtonElement | HTMLSelectElement
  >("input,button,select"))
    input.disabled = !author || !project;
}
async function refresh(local = queueWrites(), append = false) {
  const generation = ++refreshGeneration;
  let query = db.from("projects");
  if (local) query = query.local();
  const nextProjects = workspace.require("Read projects", await query);
  if (generation !== refreshGeneration) return;
  projects = nextProjects;
  project =
    projects.find(
      (item) => item.id === project?.id && item._nostr.pubkey === project?._nostr.pubkey,
    ) ?? projects[0];
  const result = project
    ? await workspace.tasks(
        project,
        element<HTMLInputElement>("search").value,
        local,
        append ? cursor : undefined,
        append ? 6 : Math.max(6, tasks.length),
      )
    : null;
  if (generation !== refreshGeneration) return;
  const page = result ? workspace.require("Task page", result) : [];
  tasks = append
    ? [
        ...tasks,
        ...page.filter(
          (row) =>
            !tasks.some((task) => task.id === row.id && task._nostr.pubkey === row._nostr.pubkey),
        ),
      ]
    : page;
  cursor = result?.meta?.nextCursor;
  renderBoard();
  await renderPending();
}
async function refreshNotes(local = queueWrites()) {
  if (!author) {
    notes = [];
    renderNotes();
    return;
  }
  let query = db.private.from("notes");
  if (local) query = query.local();
  notes = workspace.require("Read private notes", await query);
  renderNotes();
}
function renderNotes() {
  element("note-list").innerHTML =
    notes
      .map(
        (note) =>
          `<article class="note-card"><p class="eyebrow">PRIVATE NOTE</p><h2>${escapeHtml(note.title)}</h2><p class="note-body">${escapeHtml(note.body)}</p><button class="text-button" data-delete-note="${escapeHtml(note.id)}">Delete note</button></article>`,
      )
      .join("") || '<p class="empty">Your private notebook is empty.</p>';
}
async function sessionReady() {
  author = workspace.require("Get identity", await db.auth.getUser()).pubkey;
  element("identity").textContent =
    `${element<HTMLInputElement>("display-name").value} · ${author.slice(0, 6)}`;
  element("public-key").textContent = author;
  await workspace.signedIn(element<HTMLInputElement>("display-name").value, () => {
    void refreshNotes(true).catch((error) => tell(error.message, true));
  });
  element<HTMLDialogElement>("identity-dialog").close();
  tell("Identity connected. Your workspace is ready.");
  await refresh();
  await refreshNotes();
}
function showView(id: string) {
  for (const view of document.querySelectorAll<HTMLElement>(".view")) view.hidden = view.id !== id;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    if (button.dataset.view === id) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  element("page-name").textContent =
    {
      board: "Project board",
      notes: "Private notebook",
      files: "Files",
      tools: "Developer console",
    }[id] ?? id;
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]"))
  button.addEventListener("click", () => showView(button.dataset.view as string));
for (const button of document.querySelectorAll<HTMLButtonElement>(".close-dialog"))
  button.addEventListener("click", () => button.closest("dialog")?.close());
element("identity").addEventListener("click", () =>
  element<HTMLDialogElement>("identity-dialog").showModal(),
);
element("new-project").addEventListener("click", () =>
  element<HTMLDialogElement>("project-dialog").showModal(),
);
action("demo", async () => {
  let key = sessionStorage.getItem(demoStorageKey);
  if (!key)
    key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  workspace.require("Demo sign in", await db.auth.signInWithSigner(PrivateKeySigner.fromKey(key)));
  await remoteSigner?.close();
  remoteSigner = undefined;
  sessionStorage.setItem(demoStorageKey, key);
  await sessionReady();
});
action("extension", async () => {
  workspace.require("Extension sign in", await db.auth.signInWithExtension());
  await remoteSigner?.close();
  remoteSigner = undefined;
  sessionStorage.removeItem(demoStorageKey);
  await sessionReady();
});
action("remote", async () => {
  const signer = await NostrConnectSigner.fromBunkerURI(element<HTMLInputElement>("bunker").value, {
    pool: db.pool,
  });
  workspace.require("Remote sign in", await db.auth.signInWithSigner(signer));
  await remoteSigner?.close();
  remoteSigner = signer;
  sessionStorage.removeItem(demoStorageKey);
  await sessionReady();
});
action("signout", async () => {
  await workspace.signOut();
  await remoteSigner?.close();
  remoteSigner = undefined;
  sessionStorage.removeItem(demoStorageKey);
  author = "";
  notes = [];
  renderNotes();
  renderBoard();
  element("identity").textContent = "Connect identity ↗";
  element("public-key").textContent = "";
  element<HTMLDialogElement>("identity-dialog").close();
  tell("Signed out. Private notes are hidden.");
});
action(
  "project-form",
  async () => {
    let query = db
      .from("projects")
      .insert({
        title: element<HTMLInputElement>("new-project-title").value,
        description: element<HTMLTextAreaElement>("new-project-description").value,
      })
      .select()
      .single();
    if (queueWrites()) query = query.queue();
    project = workspace.require("Create project", await query);
    element<HTMLDialogElement>("project-dialog").close();
    element<HTMLFormElement>("project-form").reset();
    await refresh(true);
    tell("Project created.");
  },
  "submit",
);
action("sample", async () => {
  project = workspace.require(
    "Create sample project",
    await db
      .from("projects")
      .insert({
        title: "A more open internet",
        description: "One small workspace. A new way to build together.",
      })
      .queue()
      .select()
      .single(),
  );
  for (const [index, title] of [
    "Sketch the first experience",
    "Make the small things feel good",
    "Write a clear getting-started guide",
    "Invite a second perspective",
    "Check the offline experience",
    "Connect files to the work",
    "Listen for live updates",
    "Leave room for iteration",
    "Ship something useful",
  ].entries()) {
    const task = await workspace.addTask(project, title, index === 1 ? "high" : "normal", true);
    if (index === 1 || index === 2 || index === 7)
      await workspace.updateTask(task, { status: index === 7 ? "done" : "active" }, true);
  }
  if (!queueWrites()) {
    const result = workspace.record("Replay sample writes", await db.offline.flush());
    if (result.error) throw result.error;
  }
  await refresh(true);
  tell("Sample project loaded. Open a card to edit it.");
});
action(
  "task-form",
  async () => {
    if (!project) throw new Error("Select a project first.");
    const created = await workspace.addTask(
      project,
      element<HTMLInputElement>("task-title").value,
      element<HTMLSelectElement>("task-priority").value as "normal" | "high",
      queueWrites(),
    );
    element<HTMLInputElement>("task-title").value = "";
    await refresh(true);
    if (
      !tasks.some((task) => task.id === created.id && task._nostr.pubkey === created._nostr.pubkey)
    ) {
      tasks = [created, ...tasks];
      renderBoard();
    }
    tell(
      queueWrites()
        ? "Task queued on this device. Replay it when ready."
        : "Task accepted by the relay.",
    );
  },
  "submit",
);
action("refresh", async () => {
  await refresh();
  tell("Workspace refreshed.");
});
action("more", async () => {
  await refresh(queueWrites(), true);
});
element("search").addEventListener("input", () => {
  void refresh(true).catch((error) => tell(error.message, true));
});
element("queue").addEventListener("change", () => {
  tell(
    queueWrites()
      ? "Writes will be signed and queued locally."
      : "New writes will go to the relay. Existing queued writes need explicit replay.",
  );
});
element("projects").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-project]");
  if (!button) return;
  project = projects.find(
    (item) => item.id === button.dataset.project && item._nostr.pubkey === button.dataset.author,
  );
  void refresh(true).catch((error) => tell(error.message, true));
});
function renderDetail() {
  if (!selected) return;
  element("detail-title").textContent = selected.title;
  element("detail-author").textContent =
    `Author: ${selected._nostr.pubkey}${selected._nostr.pubkey !== author ? " · Read only" : ""}`;
  element("detail-revision").textContent = `Record revision ${selected.revision}`;
  element<HTMLInputElement>("edit-task-title").value = selected.title;
  element<HTMLSelectElement>("edit-task-status").value = selected.status;
  for (const id of [
    "edit-task-title",
    "edit-task-status",
    "save-task",
    "delete-task",
    "attachment",
  ])
    element<HTMLInputElement>(id).disabled = selected._nostr.pubkey !== author;
  element("task-attachment").innerHTML = selected.attachment
    ? `<p>${escapeHtml(selected.attachment.name)}</p><button id="get-attachment" class="button secondary">Download attachment</button>`
    : "";
  if (selected.attachment)
    action("get-attachment", async () => {
      if (!selected?.attachment) return;
      const blob = workspace.require(
        "Download attachment",
        await db.storage.from(selected.attachment.server).download(selected.attachment.sha256),
      );
      download(selected.attachment.name, blob);
      tell("Attachment hash verified.");
    });
}
document.querySelector(".kanban")?.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-task]");
  if (!button) return;
  selected = tasks.find(
    (item) => item.id === button.dataset.task && item._nostr.pubkey === button.dataset.author,
  );
  if (!selected) return;
  renderDetail();
  element<HTMLDialogElement>("task-dialog").showModal();
  try {
    const resolved = workspace.require(
      "Resolve project reference",
      await db.relations.resolve(selected.project),
    );
    element("detail-project").textContent = `Project: ${resolved.title}`;
  } catch (error) {
    element("detail-project").textContent =
      error instanceof Error ? error.message : "Project unavailable";
  }
});
action(
  "edit-task-form",
  async () => {
    if (!selected) return;
    selected = await workspace.updateTask(
      selected,
      {
        title: element<HTMLInputElement>("edit-task-title").value,
        status: element<HTMLSelectElement>("edit-task-status").value as Task["status"],
      },
      queueWrites(),
    );
    element<HTMLDialogElement>("task-dialog").close();
    await refresh(true);
    tell("Task updated.");
  },
  "submit",
);
action("delete-task", async () => {
  if (!selected) return;
  await workspace.deleteTask(selected, queueWrites());
  element<HTMLDialogElement>("task-dialog").close();
  selected = undefined;
  await refresh(true);
  tell("Signed deletion sent. Other copies can still exist.");
});
action(
  "attachment",
  async () => {
    const file = element<HTMLInputElement>("attachment").files?.[0];
    if (!file || !selected) return;
    if (queueWrites()) throw new Error("Upload attachments while online, with Queue writes off.");
    const uploaded = workspace.require(
      "Upload attachment",
      await db.storage.from(config.blossom).upload(file.name, file),
    );
    selected = await workspace.updateTask(
      selected,
      { attachment: { sha256: uploaded.sha256, name: uploaded.name, server: config.blossom } },
      false,
    );
    renderDetail();
    await refresh(true);
    tell("File uploaded and attached. This file is public.");
  },
  "change",
);
action(
  "note-form",
  async () => {
    let query = db.private.from("notes").insert({
      title: element<HTMLInputElement>("note-title").value,
      body: element<HTMLTextAreaElement>("note-body").value,
    });
    if (queueWrites()) query = query.queue();
    const result = workspace.record("Save encrypted note", await query);
    if (result.error) throw result.error;
    element<HTMLFormElement>("note-form").reset();
    await refreshNotes(true);
    tell("Private note saved as ciphertext.");
  },
  "submit",
);
element("note-list").addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-delete-note]");
  if (!button) return;
  try {
    let query = db.private
      .from("notes")
      .delete()
      .eq("id", button.dataset.deleteNote as string);
    if (queueWrites()) query = query.queue();
    const result = workspace.record("Delete private note", await query);
    if (result.error) throw result.error;
    await refreshNotes(true);
    tell("Private note deleted.");
  } catch (error) {
    tell(error instanceof Error ? error.message : String(error), true);
  }
});
action(
  "signal-form",
  async () => {
    if (!workspace.room) return;
    const result = workspace.record(
      "Broadcast room update",
      await workspace.room.send({
        type: "broadcast",
        event: "message",
        payload: element<HTMLInputElement>("signal-text").value,
      }),
    );
    if (result.error) throw result.error;
    element<HTMLInputElement>("signal-text").value = "";
    tell("Room update sent. It is public and ephemeral.");
  },
  "submit",
);
function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function renderFiles() {
  const files = workspace.require(
    "List Blossom files",
    await db.storage.from(config.blossom).list(),
  );
  element("file-list").innerHTML =
    files
      .map(
        (file: BlobDescriptor) =>
          `<article class="file-row"><span class="file-icon">↥</span><div><strong>${file.sha256.slice(0, 16)}…</strong><small>${file.type} · ${file.size} bytes</small></div><button class="button secondary" data-download="${file.sha256}">Download file</button><button class="text-button" data-remove="${file.sha256}">Remove file</button></article>`,
      )
      .join("") || '<p class="empty">No files uploaded by this identity.</p>';
}
action("list-files", renderFiles);
element("file-list").addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-download],[data-remove]",
  );
  if (!button) return;
  try {
    if (button.dataset.download)
      download(
        button.dataset.download,
        workspace.require(
          "Download file",
          await db.storage.from(config.blossom).download(button.dataset.download),
        ),
      );
    else {
      workspace.require(
        "Remove file",
        await db.storage.from(config.blossom).remove([button.dataset.remove as string]),
      );
      await renderFiles();
      tell("File removed from this server. Task references can remain.");
    }
  } catch (error) {
    tell(error instanceof Error ? error.message : String(error), true);
  }
});
action("flush", async () => {
  const result = workspace.record("Replay queued writes", await db.offline.flush());
  if (result.error) throw result.error;
  await refresh(true);
  tell("Queued writes replayed. Check the receipts in the operation log.");
});
action("pause-live", async () => {
  if (!workspace.room) return;
  if (livePaused) {
    workspace.room.subscribe();
    if (author)
      workspace.record(
        "Resume presence",
        await workspace.room.track({ name: element<HTMLInputElement>("display-name").value }),
      );
  } else {
    if (author) workspace.record("Pause presence", await workspace.room.untrack());
    workspace.room.unsubscribe();
  }
  livePaused = !livePaused;
  element("pause-live").textContent = livePaused ? "Resume live updates" : "Pause live updates";
  tell(
    livePaused
      ? "Live updates paused. Use recovery to pull missed records."
      : "Live updates resumed.",
  );
});
for (const id of ["sync", "query-sync"])
  action(id, async () => {
    const result = workspace.record(
      "Recover workspace",
      await db.sync.pull(undefined, { strategy: id === "query-sync" ? "query" : "auto" }),
    );
    element("sync-result").textContent = JSON.stringify(result.meta?.sync, null, 2);
    if (result.error) throw result.error;
    await refresh(true);
    tell("Recovery complete.");
  });
action("preview-migration", async () => {
  const result = workspace.require(
    "Preview task migration",
    await db.migrations.run("tasks", (data) => ({ ...data, revision: 2 }), {
      dryRun: true,
      queue: queueWrites(),
    }),
  );
  element("migration-result").textContent =
    `Preview: ${result.changed} of ${result.examined} owned tasks will change.`;
  element<HTMLButtonElement>("apply-migration").disabled = !result.changed;
});
action("apply-migration", async () => {
  const result = workspace.require(
    "Apply task migration",
    await db.migrations.run("tasks", (data) => ({ ...data, revision: 2 }), {
      queue: queueWrites(),
    }),
  );
  element("migration-result").textContent = `Applied: ${result.changed} owned tasks upgraded.`;
  element<HTMLButtonElement>("apply-migration").disabled = true;
  await refresh(true);
  tell("Migration applied to your records.");
});
action("export", async () => {
  element<HTMLTextAreaElement>("backup").value = JSON.stringify(
    workspace.require("Export signed backup", await db.backup.export()),
    null,
    2,
  );
  tell("Signed backup exported. Private plaintext is excluded.");
});
action("import", async () => {
  const result = workspace.require(
    "Import signed backup",
    await db.backup.import(element<HTMLTextAreaElement>("backup").value),
  );
  await refresh(true);
  await refreshNotes(true);
  tell(`Backup restored locally: ${result.imported} imported, ${result.duplicates} duplicates.`);
});
action("download-backup", async () => {
  download(
    "fieldwork-backup.json",
    new Blob([element<HTMLTextAreaElement>("backup").value], { type: "application/json" }),
  );
});
action(
  "profile-form",
  async () => {
    const event = workspace.require(
      "Publish native profile",
      await db.events.publish({
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        content: JSON.stringify({ name: element<HTMLInputElement>("profile-name").value }),
        tags: [],
      }),
    );
    element("profile-result").textContent = event.content;
    tell("Native Nostr profile published.");
  },
  "submit",
);
action("read-profile", async () => {
  if (!author) throw new Error("Connect an identity first.");
  const events = workspace.require(
    "Read native profile",
    await db.events.query({ kinds: [0], authors: [author] }),
  );
  element("profile-result").textContent = events[0]?.content ?? "No profile found.";
});
action(
  "native-search-form",
  async () => {
    const events = workspace.require(
      "NIP-50 search",
      await db.events.search(element<HTMLInputElement>("native-search").value, {
        kinds: [1],
        "#t": [scopeTag(config.namespace, "events")],
      }),
    );
    element("sync-result").textContent = JSON.stringify(events, null, 2);
  },
  "submit",
);
action(
  "public-update-form",
  async () => {
    workspace.require(
      "Publish native activity",
      await db.events.publish({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        content: element<HTMLInputElement>("public-update").value,
        tags: [["t", scopeTag(config.namespace, "events")]],
      }),
    );
    element<HTMLInputElement>("public-update").value = "";
    tell("Public activity published as a standard Nostr event.");
  },
  "submit",
);
function networkChanged() {
  element("network-label").textContent = navigator.onLine ? "Online" : "Offline · writes queued";
  document.body.classList.toggle("offline", !navigator.onLine);
}
window.addEventListener("online", networkChanged);
window.addEventListener("offline", networkChanged);
window.addEventListener("pagehide", () => {
  void remoteSigner?.close();
  void workspace.close();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
networkChanged();
renderBoard();
renderNotes();
async function start() {
  await workspace.connect(
    () => {
      void refresh(true).catch((error) => tell(error.message, true));
    },
    (count) => {
      element("presence").textContent = `${count} here`;
    },
    (text) => {
      element("signal").textContent = text;
    },
  );
  inspector = db.dashboard.mount(element("inspector"), { interval: 5000 });
  const key = sessionStorage.getItem(demoStorageKey);
  if (key) {
    workspace.require("Restore demo identity", await db.auth.signInWithPrivateKey(key));
    await sessionReady();
  } else await refresh(!navigator.onLine);
  try {
    const response = await fetch(config.relay.replace(/^ws/, "http"), {
      headers: { Accept: "application/nostr+json" },
      signal: AbortSignal.timeout(3000),
    });
    const info = (await response.json()) as {
      supported_nips?: number[];
      name?: string;
      version?: string;
    };
    const search = info.supported_nips?.includes(50) ?? false;
    element("capabilities").textContent =
      `${info.name ?? "Relay"} ${info.version ?? ""} · NIP-77 ${info.supported_nips?.includes(77) ? "advertised" : "not advertised"} · NIP-50 ${search ? "advertised" : "not supported"}`;
    element<HTMLButtonElement>("native-search-button").disabled = !search;
  } catch {
    element("capabilities").textContent =
      "Relay capabilities unavailable. NIP-50 search is disabled.";
  }
}
void start().catch((error) => tell(error instanceof Error ? error.message : String(error), true));
