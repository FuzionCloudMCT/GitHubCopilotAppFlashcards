const RESET_MS = 60_000;
const tabsEl = document.getElementById('tabs');
const panelsEl = document.getElementById('panels');
const timers = new Map();

function unflip(card) {
  clearTimeout(timers.get(card));
  timers.delete(card);
  card.setAttribute('aria-pressed', 'false');
  card.querySelector('.back').inert = true;
}

function flip(card) {
  if (card.getAttribute('aria-pressed') === 'true') return unflip(card);
  card.setAttribute('aria-pressed', 'true');
  card.querySelector('.back').inert = false;
  timers.set(card, setTimeout(() => unflip(card), RESET_MS));
}

function makeCard({ q, a, url }) {
  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('aria-pressed', 'false');
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.innerHTML = `<div class="inner">
    <div class="face front"><span></span><span class="hint">Click to reveal the answer</span></div>
    <div class="face back"><p></p><a target="_blank" rel="noopener noreferrer">Read the docs</a></div>
  </div>`;
  card.querySelector('.front span').textContent = q;
  card.querySelector('.back p').textContent = a;
  card.querySelector('.back a').href = url;
  card.querySelector('.back').inert = true;
  card.addEventListener('click', (e) => { if (!e.target.closest('a')) flip(card); });
  card.addEventListener('keydown', (e) => {
    if (e.target === card && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      flip(card);
    }
  });
  return card;
}

function select(tabs, panels, index) {
  tabs.forEach((t, i) => {
    t.setAttribute('aria-selected', String(i === index));
    t.tabIndex = i === index ? 0 : -1;
    panels[i].hidden = i !== index;
  });
  document.querySelectorAll('.card[aria-pressed="true"]').forEach(unflip);
}

async function init() {
  const topics = await (await fetch('cards.json')).json();
  const tabs = [];
  const panels = [];
  topics.forEach((topic, i) => {
    const tab = document.createElement('button');
    tab.setAttribute('role', 'tab');
    tab.id = `tab-${topic.id}`;
    tab.setAttribute('aria-controls', `panel-${topic.id}`);
    tab.textContent = topic.title;
    const panel = document.createElement('section');
    panel.setAttribute('role', 'tabpanel');
    panel.id = `panel-${topic.id}`;
    panel.setAttribute('aria-labelledby', tab.id);
    panel.append(...topic.cards.map(makeCard));
    tab.addEventListener('click', () => select(tabs, panels, i));
    tab.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      let next = step === undefined ? (e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null)
        : (i + step + tabs.length) % tabs.length;
      if (next === null) return;
      e.preventDefault();
      select(tabs, panels, next);
      tabs[next].focus();
    });
    tabs.push(tab);
    panels.push(panel);
  });
  tabsEl.append(...tabs);
  panelsEl.append(...panels);
  select(tabs, panels, 0);
}

init().catch(() => {
  panelsEl.textContent = 'Could not load cards. Serve this folder over HTTP (see README).';
});
