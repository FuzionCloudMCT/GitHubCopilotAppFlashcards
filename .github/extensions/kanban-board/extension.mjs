import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";

const DEFAULT_FILE = "docs/kanban.json";
const DEFAULT_COLUMNS = ["Backlog", "In progress", "Done"];

function findRepoRoot(start) {
    let dir = resolve(start);
    while (true) {
        if (existsSync(join(dir, ".git"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return resolve(start);
        dir = parent;
    }
}
const REPO_ROOT = findRepoRoot(process.cwd());

function boardPath(file) {
    const p = resolve(REPO_ROOT, file || DEFAULT_FILE);
    if (!p.startsWith(REPO_ROOT)) throw new CanvasError("invalid_path", "Board file must be inside the repo");
    return p;
}

function load(file) {
    const p = boardPath(file);
    if (!existsSync(p)) return { columns: [...DEFAULT_COLUMNS], cards: [] };
    try {
        const b = JSON.parse(readFileSync(p, "utf8"));
        if (!Array.isArray(b.columns) || !b.columns.length) b.columns = [...DEFAULT_COLUMNS];
        if (!Array.isArray(b.cards)) b.cards = [];
        return b;
    } catch (e) {
        throw new CanvasError("board_unreadable", `Cannot parse ${file}: ${e.message}`);
    }
}

function save(file, board) {
    const p = boardPath(file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(board, null, 2) + "\n");
}

function mutate(file, fn) {
    const board = load(file);
    const result = fn(board);
    save(file, board);
    return result;
}

function checkColumn(board, column) {
    if (!board.columns.includes(column)) {
        throw new CanvasError("invalid_column", `Unknown column "${column}". Valid: ${board.columns.join(", ")}`);
    }
}

function findCard(board, id) {
    const c = board.cards.find((x) => x.id === id);
    if (!c) throw new CanvasError("card_not_found", `No card with id "${id}"`);
    return c;
}

const ops = {
    add(file, { title, description = "", column }) {
        return mutate(file, (b) => {
            if (!title || !String(title).trim()) throw new CanvasError("invalid_title", "title is required");
            const col = column || b.columns[0];
            checkColumn(b, col);
            const card = { id: "c-" + randomUUID().slice(0, 8), title: String(title).trim(), description, column: col };
            b.cards.push(card);
            return card;
        });
    },
    update(file, { id, title, description }) {
        return mutate(file, (b) => {
            const c = findCard(b, id);
            if (title !== undefined) c.title = String(title);
            if (description !== undefined) c.description = String(description);
            return c;
        });
    },
    move(file, { id, column, index }) {
        return mutate(file, (b) => {
            checkColumn(b, column);
            const c = findCard(b, id);
            b.cards = b.cards.filter((x) => x !== c);
            c.column = column;
            if (Number.isInteger(index)) {
                const colCards = b.cards.filter((x) => x.column === column);
                const ref = colCards[Math.max(0, Math.min(index, colCards.length))];
                const at = ref ? b.cards.indexOf(ref) : b.cards.length;
                b.cards.splice(at, 0, c);
            } else {
                b.cards.push(c);
            }
            return c;
        });
    },
    remove(file, { id }) {
        return mutate(file, (b) => {
            const c = findCard(b, id);
            b.cards = b.cards.filter((x) => x !== c);
            return { deleted: id };
        });
    },
};

// One loopback server per instance; the board file is the source of truth.
const servers = new Map();

function readBody(req) {
    return new Promise((resolveBody, reject) => {
        let data = "";
        req.on("data", (d) => (data += d));
        req.on("end", () => {
            try { resolveBody(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
        });
    });
}

async function startServer(file) {
    const clients = new Set();
    let lastJson = "";
    const broadcast = () => {
        let json;
        try { json = JSON.stringify(load(file)); } catch { return; }
        if (json === lastJson) return;
        lastJson = json;
        for (const c of clients) c.write(`data: ${json}\n\n`);
    };
    const p = boardPath(file);
    mkdirSync(dirname(p), { recursive: true });
    if (!existsSync(p)) save(file, load(file));
    let watcher;
    try { watcher = watch(dirname(p), () => broadcast()); } catch { /* polling covers it */ }
    const poll = setInterval(broadcast, 2000);

    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://127.0.0.1");
            const post = { "/add": ops.add, "/update": ops.update, "/move": ops.move, "/delete": ops.remove }[url.pathname];
            if (req.method === "GET" && url.pathname === "/") {
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(renderHtml(file));
            } else if (req.method === "GET" && url.pathname === "/board") {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(load(file)));
            } else if (req.method === "GET" && url.pathname === "/events") {
                res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
                res.write(`data: ${JSON.stringify(load(file))}\n\n`);
                clients.add(res);
                req.on("close", () => clients.delete(res));
            } else if (req.method === "POST" && post) {
                const out = post(file, await readBody(req));
                broadcast();
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(out));
            } else {
                res.statusCode = 404;
                res.end("not found");
            }
        } catch (e) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: e.message }));
        }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { server, url: `http://127.0.0.1:${server.address().port}/`, watcher, poll, clients };
}

const fileOf = (input) => (input && input.file) || DEFAULT_FILE;

const cardProps = {
    id: { type: "string", description: "Card id" },
    title: { type: "string" },
    description: { type: "string" },
    column: { type: "string", description: "Column name, e.g. Backlog, In progress, Done" },
};

await joinSession({
    canvases: [
        createCanvas({
            id: "kanban-board",
            displayName: "Kanban board",
            description: "Interactive Kanban board of future flashcard-site features, stored in docs/kanban.json; editable by both user and agent.",
            inputSchema: {
                type: "object",
                properties: { file: { type: "string", description: "Repo-relative board JSON path (default docs/kanban.json)" } },
            },
            actions: [
                { name: "list_cards", description: "Return the board columns and all cards.", handler: async (ctx) => load(fileOf(ctx.input)) },
                {
                    name: "add_card", description: "Add a card (defaults to the first column).",
                    inputSchema: { type: "object", required: ["title"], properties: { title: cardProps.title, description: cardProps.description, column: cardProps.column } },
                    handler: async (ctx) => ops.add(fileOf(ctx.input), ctx.input),
                },
                {
                    name: "update_card", description: "Edit a card's title and/or description.",
                    inputSchema: { type: "object", required: ["id"], properties: { id: cardProps.id, title: cardProps.title, description: cardProps.description } },
                    handler: async (ctx) => ops.update(fileOf(ctx.input), ctx.input),
                },
                {
                    name: "move_card", description: "Move a card to a column, optionally at a position.",
                    inputSchema: { type: "object", required: ["id", "column"], properties: { id: cardProps.id, column: cardProps.column, index: { type: "integer", minimum: 0 } } },
                    handler: async (ctx) => ops.move(fileOf(ctx.input), ctx.input),
                },
                {
                    name: "delete_card", description: "Delete a card by id.",
                    inputSchema: { type: "object", required: ["id"], properties: { id: cardProps.id } },
                    handler: async (ctx) => ops.remove(fileOf(ctx.input), ctx.input),
                },
            ],
            open: async (ctx) => {
                const file = fileOf(ctx.input);
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(file);
                    servers.set(ctx.instanceId, entry);
                }
                return { url: entry.url, title: "Kanban board", status: file };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (!entry) return;
                servers.delete(ctx.instanceId);
                clearInterval(entry.poll);
                entry.watcher?.close();
                for (const c of entry.clients) c.end();
                await new Promise((r) => entry.server.close(() => r()));
            },
        }),
    ],
});

function renderHtml(file) {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Kanban</title>
<style>
body{margin:0;padding:12px;background:var(--background-color-default,#fff);color:var(--text-color-default,#1f2328);font-family:var(--font-sans,-apple-system,"Segoe UI",sans-serif);font-size:var(--text-body-medium,14px);line-height:var(--leading-body-medium,20px)}
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
h1{font-size:var(--text-title-large,20px);font-weight:var(--font-weight-semibold,600);margin:0}
.muted{color:var(--text-color-muted,#656d76);font-size:12px}
#board{display:flex;gap:12px;align-items:flex-start}
.col{flex:1;min-width:180px;border:1px solid var(--border-color-default,#d0d7de);border-radius:8px;padding:8px}
.col.over{outline:2px solid var(--color-focus-outline,#0969da)}
.col h2{font-size:13px;margin:0 0 8px;display:flex;justify-content:space-between}
.card{border:1px solid var(--border-color-default,#d0d7de);border-radius:6px;padding:8px;margin-bottom:8px;cursor:grab;background:var(--background-color-default,#fff)}
.card b{display:block}.card p{margin:4px 0;color:var(--text-color-muted,#656d76)}
.row{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
button{font:inherit;font-size:12px;padding:2px 8px;border:1px solid var(--border-color-default,#d0d7de);border-radius:6px;background:transparent;color:inherit;cursor:pointer}
button:hover{border-color:var(--color-focus-outline,#0969da)}
input,textarea{font:inherit;width:100%;box-sizing:border-box;margin-bottom:4px;background:transparent;color:inherit;border:1px solid var(--border-color-default,#d0d7de);border-radius:6px;padding:4px}
</style></head><body>
<header><h1>Kanban board</h1><span class="muted" id="file"></span></header>
<div id="board"></div>
<script>
document.getElementById('file').textContent=${JSON.stringify(file)}+' · live';
let board={columns:[],cards:[]},editing=null,adding=null,dragging=false;
const $=(t,a={},...k)=>{const e=document.createElement(t);for(const[x,v]of Object.entries(a))x.startsWith('on')?e[x]=v:e.setAttribute(x,v);k.flat().forEach(c=>e.append(c));return e};
const post=(p,b)=>fetch(p,{method:'POST',body:JSON.stringify(b)}).then(r=>r.json());
function form(init,onSave,onCancel){
  const t=$('input',{placeholder:'Title',value:init.title||''}),d=$('textarea',{placeholder:'Description',rows:3});d.value=init.description||'';
  return $('div',{class:'card'},t,d,$('div',{class:'row'},$('button',{onclick:()=>t.value.trim()&&onSave(t.value,d.value)},'Save'),$('button',{onclick:onCancel},'Cancel')));
}
function render(){
  if(dragging)return;
  const el=document.getElementById('board');el.replaceChildren();
  board.columns.forEach(col=>{
    const cards=board.cards.filter(c=>c.column===col);
    const c=$('div',{class:'col'},$('h2',{},col,$('span',{class:'muted'},String(cards.length))));
    c.ondragover=e=>{e.preventDefault();c.classList.add('over')};
    c.ondragleave=()=>c.classList.remove('over');
    c.ondrop=e=>{e.preventDefault();dragging=false;post('/move',{id:e.dataTransfer.getData('text/plain'),column:col})};
    cards.forEach(card=>{
      if(editing===card.id){c.append(form(card,(t,d)=>{editing=null;post('/update',{id:card.id,title:t,description:d})},()=>{editing=null;render()}));return}
      const i=board.columns.indexOf(col);
      const n=$('div',{class:'card',draggable:'true'},$('b',{},card.title),card.description?$('p',{},card.description):'',
        $('div',{class:'row'},
          i>0?$('button',{onclick:()=>post('/move',{id:card.id,column:board.columns[i-1]})},'←'):'',
          i<board.columns.length-1?$('button',{onclick:()=>post('/move',{id:card.id,column:board.columns[i+1]})},'→'):'',
          $('button',{onclick:()=>{editing=card.id;render()}},'Edit'),
          $('button',{onclick:()=>post('/delete',{id:card.id})},'Delete')));
      n.ondragstart=e=>{dragging=true;e.dataTransfer.setData('text/plain',card.id)};
      n.ondragend=()=>{dragging=false;render()};
      c.append(n);
    });
    c.append(adding===col?form({},(t,d)=>{adding=null;post('/add',{title:t,description:d,column:col})},()=>{adding=null;render()}):$('button',{onclick:()=>{adding=col;render()}},'+ Add card'));
    el.append(c);
  });
}
new EventSource('/events').onmessage=e=>{board=JSON.parse(e.data);render()};
</script></body></html>`;
}
