// The My workflows page: add the user's own ComfyUI workflows, choose where the page image goes in and where the
// result comes out, and which inputs become popup settings. The helpers are shared/custom-workflows.js's; the
// definitions are saved in chrome.storage.local customWorkflows (the popup and content script read them there).

const EXPORT_MARKER = 'img2imgWorkflow'; // set in files exported from this page, so they import as they are

// Dark mode, shared with the popup and the other extension pages
document.querySelector('header').append(img2imgTheme.button('theme-toggle'));
const $ = id => document.getElementById(id);

let workflows = [];
// The workflow being edited (see startEditing). Its checked Map's order is the order of the settings in the popup.
let editing = null;

function showError(message) {
  $('pageError').textContent = message || '';
  $('pageError').hidden = !message;
  if (message) window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadWorkflows() {
  const { customWorkflows = [], processingMode } = await chrome.storage.local.get(['customWorkflows', 'processingMode']);
  workflows = customWorkflows;
  $('processingNotice').hidden = processingMode === 'local';
  renderList();
}

async function saveWorkflows(list) {
  try {
    await chrome.storage.local.set({ customWorkflows: list });
    workflows = list;
    renderList();
    return true;
  } catch (error) {
    showError(`Couldn't save: ${error.message}`);
    return false;
  }
}

function renderList() {
  const container = $('workflowList');
  container.replaceChildren(...workflows.map(definition => {
    const row = document.createElement('div');
    row.className = 'workflow-row';
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'workflow-name';
    name.textContent = definition.name;
    const details = document.createElement('div');
    details.className = 'muted';
    const count = definition.settings.length;
    details.textContent = `${Object.keys(definition.graph).length} nodes, ${count} ${count === 1 ? 'setting' : 'settings'} in the popup`;
    info.append(name, details);
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      button('Edit', () => editWorkflow(definition)),
      button('Export', () => exportWorkflow(definition)),
      button('Delete', () => deleteWorkflow(definition), 'danger'),
    );
    row.append(info, actions);
    return row;
  }));
  $('emptyList').hidden = workflows.length > 0;
}

function button(text, onClick, className = '') {
  const element = document.createElement('button');
  element.textContent = text;
  element.className = className;
  element.addEventListener('click', onClick);
  return element;
}

// ComfyUI's node definitions, or null when it can't be reached
async function fetchObjectInfo() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'comfyRequest', url: '/object_info', method: 'GET' });
    return response?.success && response.data && typeof response.data === 'object' ? response.data : null;
  } catch {
    return null;
  }
}

$('addWorkflow').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  showError('');
  let json;
  try {
    json = JSON.parse(await file.text());
  } catch {
    showError(`${file.name} isn't a JSON file.`);
    return;
  }
  if (json?.[EXPORT_MARKER]) {
    importWorkflow(json, file.name);
    return;
  }
  const objectInfo = await fetchObjectInfo();
  let parsed;
  try {
    parsed = parseComfyWorkflow(json, objectInfo);
  } catch (error) {
    showError(error.message);
    return;
  }
  startEditing({ name: file.name.replace(/\.json$/i, ''), graph: parsed.graph, layout: parsed.layout, objectInfo, warnings: parsed.warnings, settings: [] });
});

// A workflow exported from this page: added as it is (one with the same id is replaced)
async function importWorkflow(json, fileName) {
  const { [EXPORT_MARKER]: _marker, ...definition } = json;
  const valid = typeof definition.id === 'string' && typeof definition.name === 'string' && definition.graph && typeof definition.graph === 'object'
    && definition.graph[definition.imageNode] && definition.graph[definition.outputNode] && Array.isArray(definition.settings);
  if (!valid) {
    showError(`${fileName} isn't a complete img2img workflow export.`);
    return;
  }
  definition.version = Date.now();
  await saveWorkflows([...workflows.filter(item => item.id !== definition.id), definition]);
}

function exportWorkflow(definition) {
  const blob = new Blob([JSON.stringify({ [EXPORT_MARKER]: 1, ...definition }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${definition.name.replace(/[\\/:*?"<>|]+/g, '_')}.img2img-workflow.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function deleteWorkflow(definition) {
  if (!confirm(`Delete "${definition.name}"?`)) return;
  const { customWorkflowValues = {} } = await chrome.storage.local.get('customWorkflowValues');
  delete customWorkflowValues[definition.id];
  await chrome.storage.local.set({ customWorkflowValues });
  await saveWorkflows(workflows.filter(item => item.id !== definition.id));
  if (editing?.id === definition.id) closeEditor();
}

async function editWorkflow(definition) {
  showError('');
  const objectInfo = await fetchObjectInfo();
  startEditing({ ...definition, objectInfo, warnings: [] });
}

function startEditing({ id, name, graph, layout, objectInfo, warnings, imageNode, outputNode, sourceNodes = [], settings }) {
  const imageNodes = imageInputNodes(graph, objectInfo);
  const outputs = imageOutputNodes(graph, objectInfo);
  if (!imageNodes.length) {
    showError('This workflow has no Load Image node for the image from the page. Add one in ComfyUI, then save the workflow again.');
    return;
  }
  if (!outputs.length) {
    showError('This workflow has no Save Image or Preview Image node with an image going in. Add one in ComfyUI, then save the workflow again.');
    return;
  }
  editing = {
    id, graph, objectInfo, imageNodes, outputs,
    layout: layout?.scopes ? layout : autoLayout(graph),
    savedLayout: layout?.scopes ? layout : null,
    scope: '',
    selected: null,
    // By default the page image goes into a Load Image node that doesn't feed a node together with others (those
    // are usually a set of sources, like a batch)
    imageNode: imageNodes.includes(imageNode) ? imageNode : defaultPageImage(graph, objectInfo, imageNodes),
    outputNode: outputs.some(output => output.node === outputNode) ? outputNode : outputs[0].node,
    // Load Image nodes that get a source from the popup: node -> { label, batch }
    // Load Image nodes that get a source from the popup: node -> { group, label, batch }. Nodes with the same group
    // share one picker and get its images in this Map's order.
    sources: new Map(sourceNodes.filter(source => imageNodes.includes(source.node)).map(source => [source.node, { group: source.group || source.node, label: source.label, batch: Boolean(source.batch) }])),
    checked: new Map(settings.map(setting => [`${setting.node}.${setting.input}`, setting.label])),
    showAll: true,
  };
  // A new workflow: every other Load Image node gets a source, one picker per set of nodes feeding the same node
  if (!id) {
    suggestSourceGroups(graph, objectInfo, editing.imageNode).forEach((group, index, groups) => {
      const titled = group.map(node => graph[node]._meta?.title).find(title => title && !/^load ?image$/i.test(title));
      const label = titled || (groups.length > 1 ? `Source ${index + 1}` : 'Source');
      group.forEach(node => editing.sources.set(node, { group: group[0], label, batch: false }));
    });
  }
  const notes = [...warnings];
  if (!objectInfo) {
    notes.unshift("Couldn't reach ComfyUI, so the settings' ranges and choices are guessed from their values. Start ComfyUI and edit the workflow again to fix them.");
  }
  const box = $('editorWarnings');
  box.replaceChildren();
  if (notes.length) {
    box.append('Check before using it:');
    const list = document.createElement('ul');
    list.append(...notes.map(note => Object.assign(document.createElement('li'), { textContent: note })));
    box.append(list);
  }
  box.hidden = !notes.length;
  $('editorTitle').textContent = id ? `Edit "${name}"` : 'New workflow';
  $('workflowName').value = name;
  $('settingsFilter').value = '';
  $('editorCard').hidden = false;
  renderEditor();
  fitGraph();
  $('editorCard').scrollIntoView({ behavior: 'smooth' });
}

// The first Load Image node, in the workflow's own order, that isn't one of a set feeding the same node
function defaultPageImage(graph, objectInfo, imageNodes) {
  const inSets = new Set(suggestSourceGroups(graph, objectInfo, null).filter(group => group.length > 1).flat());
  return imageNodes.find(id => !inSets.has(id)) ?? imageNodes[0];
}

function closeEditor() {
  editing = null;
  $('editorCard').hidden = true;
}

function renderEditor() {
  renderRoles();
  renderGraph();
  renderNodePanel();
  renderCandidates();
}

const prettyInputName = name => name.replace(/[._]/g, ' ').replace(/^./, c => c.toUpperCase());

// --- Naming nodes the way the user sees them ---------------------------------------------------------------

// The file a Load Image node uses ("photo.png"), without ComfyUI's " [input]" annotation
function imageFileOf(nodeId) {
  const value = editing.graph[nodeId]?.inputs?.image;
  return typeof value === 'string' ? value.replace(/\s*\[(input|output|temp)\]$/, '') : null;
}

// The subgraphs a node is inside, outermost first ("Image Edit (Flux.2 Klein 4B)")
function subgraphPath(nodeId) {
  const titles = [];
  const parts = String(nodeId).split(':');
  for (let depth = 1; depth < parts.length; depth++) {
    const prefix = parts.slice(0, depth - 1).join(':');
    const scope = editing.layout.scopes[prefix ? `${prefix}:` : ''];
    const container = scope?.nodes.find(node => node.id === parts.slice(0, depth).join(':'));
    if (container) titles.push(container.title);
  }
  return titles;
}

// A node's name for lists: its title, the file a Load Image node uses, the subgraph it's in, and a number when
// two nodes would read the same
function nodeLabel(nodeId) {
  const base = nodeBaseLabel(nodeId);
  const same = Object.keys(editing.graph).filter(other => nodeBaseLabel(other) === base);
  return same.length > 1 ? `${base} (${same.indexOf(nodeId) + 1} of ${same.length})` : base;
}

function nodeBaseLabel(nodeId) {
  const node = editing.graph[nodeId];
  if (!node) return nodeId;
  const file = imageFileOf(nodeId);
  const inside = subgraphPath(nodeId);
  return `${node._meta?.title || node.class_type}${file ? `: ${file}` : ''}${inside.length ? ` (in ${inside.join(' › ')})` : ''}`;
}

// --- Roles: page image, sources, result --------------------------------------------------------------------

function roleOf(nodeId) {
  if (nodeId === editing.imageNode) return 'page';
  if (editing.sources.has(nodeId)) return 'source';
  if (nodeId === editing.outputNode) return 'result';
  return null;
}

function setImageRole(nodeId, role) {
  if (role === 'page') {
    // The old page image node keeps its file; a node can't be both
    editing.sources.delete(nodeId);
    editing.imageNode = nodeId;
    for (const key of editing.checked.keys()) {
      if (key.startsWith(`${nodeId}.`)) editing.checked.delete(key);
    }
  } else if (role === 'source') {
    if (nodeId === editing.imageNode) return;
    editing.sources.set(nodeId, { group: nodeId, label: `Source ${sourceGroupList().length + 1}`, batch: false });
  } else {
    editing.sources.delete(nodeId);
  }
  renderEditor();
}

// The source pickers as the popup will show them: [{ group, label, nodes }] in order
function sourceGroupList() {
  const groups = new Map();
  for (const [node, source] of editing.sources) {
    if (!groups.has(source.group)) groups.set(source.group, { group: source.group, label: source.label, nodes: [] });
    groups.get(source.group).nodes.push(node);
  }
  return [...groups.values()];
}

// Moves a source node to another picker (a group key), or to one of its own (its node id)
function setSourceGroup(nodeId, group) {
  const source = editing.sources.get(nodeId);
  const target = sourceGroupList().find(item => item.group === group);
  editing.sources.delete(nodeId); // re-added last, so it takes the group's next image
  editing.sources.set(nodeId, { group, label: target?.label || `Source ${sourceGroupList().length + 1}`, batch: target ? false : source.batch });
  renderEditor();
}

function renderRoles() {
  const container = $('roles');
  const link = nodeId => {
    const element = button(nodeLabel(nodeId), () => selectNode(nodeId, true));
    element.title = 'Show it in the workflow';
    return element;
  };
  const part = (text, nodes) => {
    const span = document.createElement('span');
    span.append(`${text}: `);
    nodes.forEach((nodeId, index) => span.append(...(index ? [', '] : []), link(nodeId)));
    if (!nodes.length) span.append('none');
    return span;
  };
  const sources = sourceGroupList().map(group => part(`Source "${group.label}"`, group.nodes));
  container.replaceChildren(
    part('Page image', [editing.imageNode]),
    ...(sources.length ? sources : [part('Sources', [])]),
    part('Result', [editing.outputNode]),
  );
}

// --- The selected node --------------------------------------------------------------------------------------

function selectNode(nodeId, reveal = false) {
  editing.selected = nodeId;
  editing.showAll = !nodeId;
  if (reveal && nodeId) {
    // Open the subgraph it's in and centre on it
    const parts = String(nodeId).split(':');
    editing.scope = parts.length > 1 ? `${parts.slice(0, -1).join(':')}:` : '';
    renderGraph();
    centreOn(nodeId);
  }
  renderGraph();
  renderNodePanel();
  renderCandidates();
}

function renderNodePanel() {
  const panel = $('nodePanel');
  panel.replaceChildren();
  const nodeId = editing.selected;
  const layoutNode = nodeId && editing.layout.scopes[editing.scope]?.nodes.find(node => node.id === nodeId);
  if (!nodeId || (!editing.graph[nodeId] && !layoutNode?.enter)) {
    panel.append(Object.assign(document.createElement('div'), { className: 'muted', textContent: 'Click a node in the workflow to choose what it does, or to see its inputs.' }));
    return;
  }
  const name = document.createElement('div');
  name.className = 'node-name';
  if (layoutNode?.enter && !editing.graph[nodeId]) {
    name.textContent = `${layoutNode.title} (subgraph)`;
    panel.append(name, button('Open it', () => enterScope(layoutNode.enter)));
    return;
  }
  name.textContent = nodeLabel(nodeId);
  panel.append(name);

  if (editing.imageNodes.includes(nodeId)) {
    const role = roleOf(nodeId);
    const choice = (value, text, help) => {
      const row = document.createElement('label');
      row.className = 'choice';
      const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'imageRole', checked: (role || 'file') === value });
      radio.addEventListener('change', () => setImageRole(nodeId, value));
      row.append(radio, text);
      if (help) row.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: help }));
      return row;
    };
    panel.append(
      choice('page', 'Gets the image from the page'),
      choice('source', 'Gets a source picked in the popup', '(a face, an object to add, a style reference...)'),
      choice('file', `Keeps its file${imageFileOf(nodeId) ? ` (${imageFileOf(nodeId)})` : ''}`, "(from ComfyUI's input folder)"),
    );
    if (role === 'source') {
      const source = editing.sources.get(nodeId);
      const groups = sourceGroupList();
      const mine = groups.find(group => group.group === source.group);
      const options = document.createElement('div');
      options.className = 'source-options';
      // Which picker it takes its image from: its own, or one it shares with other Load Image nodes
      const picker = document.createElement('select');
      for (const group of groups) {
        picker.append(new Option(group === mine && group.nodes.length === 1 ? `Its own picker ("${group.label}")` : `The "${group.label}" picker`, group.group));
      }
      if (mine.nodes.length > 1) picker.append(new Option('A picker of its own', nodeId === source.group ? `${nodeId}:own` : nodeId));
      picker.value = source.group;
      picker.addEventListener('change', () => setSourceGroup(nodeId, picker.value));
      const label = Object.assign(document.createElement('input'), { type: 'text', maxLength: 40, value: source.label, placeholder: 'Name in the popup' });
      label.addEventListener('input', () => {
        // The name belongs to the picker, so every node sharing it gets it
        for (const other of editing.sources.values()) if (other.group === source.group) other.label = label.value;
        picker.selectedOptions[0].textContent = mine.nodes.length === 1 ? `Its own picker ("${label.value}")` : `The "${label.value}" picker`;
        renderRoles();
        renderGraph();
      });
      options.append(
        Object.assign(document.createElement('div'), { className: 'muted', textContent: 'Picker in the popup' }), picker,
        Object.assign(document.createElement('div'), { className: 'muted', textContent: 'Name in the popup' }), label,
      );
      if (mine.nodes.length > 1) {
        options.append(Object.assign(document.createElement('div'), {
          className: 'muted',
          textContent: `Gets image ${mine.nodes.indexOf(nodeId) + 1} of the ${mine.nodes.length} this picker's source gives (its last image again if it has fewer).`,
        }));
      } else {
        const batchRow = document.createElement('label');
        batchRow.className = 'choice';
        const batch = Object.assign(document.createElement('input'), { type: 'checkbox', checked: source.batch });
        batch.addEventListener('change', () => { source.batch = batch.checked; });
        batchRow.append(batch, 'Use all of the source\'s images, as a batch (otherwise its first image)');
        options.append(batchRow);
      }
      panel.append(options);
    }
  } else if (editing.outputs.some(output => output.node === nodeId)) {
    if (nodeId === editing.outputNode) {
      panel.append(Object.assign(document.createElement('div'), { textContent: 'The result comes from this node.' }));
    } else {
      panel.append(button('The result comes from here', () => { editing.outputNode = nodeId; renderEditor(); }));
    }
  } else {
    const count = editing.candidates?.filter(candidate => candidate.node === nodeId).length || 0;
    panel.append(Object.assign(document.createElement('div'), { className: 'muted', textContent: count ? 'Its inputs are listed below: tick the ones to show in the popup.' : 'It has no inputs that can be popup settings.' }));
  }
}

// --- Drawing the workflow ----------------------------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg';
const TITLE_HEIGHT = 26;
const ROW = 20;
const THUMBNAIL = 130;
const LINK_COLOURS = { IMAGE: '#64b5f6', MASK: '#81c784', LATENT: '#ff9cf9', MODEL: '#b39ddb', CLIP: '#ffd500', VAE: '#ff6e6e', CONDITIONING: '#ffa931', INT: '#29b6f6', FLOAT: '#aed581', STRING: '#90a4ae' };
const ROLE_COLOURS = { page: '#43a047', source: '#ab47bc', result: '#1e88e5', setting: '#fb8c00' };
let view = { x: 0, y: 0, k: 1 };
let comfyAddress = 'http://127.0.0.1:8188';
chrome.storage.local.get('comfyServerAddress').then(({ comfyServerAddress }) => { comfyAddress = comfyServerAddress || comfyAddress; });

function svg(tag, attributes = {}, parent) {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  parent?.append(element);
  return element;
}

const clip = (text, length) => (text = String(text ?? '')).length > length ? `${text.slice(0, length - 1)}…` : text;

// The rows drawn in a node: its slots, then its values (the API graph's inputs that aren't links)
function nodeRows(entry) {
  const apiNode = editing.graph[entry.id];
  const slots = Math.max(entry.inputs?.length || 0, entry.outputs?.length || 0);
  const widgets = apiNode ? Object.entries(apiNode.inputs).filter(([, value]) => !(Array.isArray(value) && value.length === 2 && typeof value[0] === 'string')) : [];
  const thumbnail = apiNode && editing.objectInfo && imageFileOf(entry.id) && editing.imageNodes.includes(entry.id);
  return { slots, widgets, thumbnail, height: Math.max(ROW, slots * ROW + widgets.length * ROW + (thumbnail ? THUMBNAIL + 8 : 0) + 8) };
}

// Where a node's slot is: inputs on the left edge, outputs on the right, one row each
function slotPoint(entry, side, slot) {
  const x = side === 'in' ? entry.pos[0] : entry.pos[0] + entry.size[0];
  return [x, entry.pos[1] + 12 + slot * ROW];
}

// Which roles a node (or, for a subgraph, a node inside it) has
function nodeRoles(entry) {
  const ids = entry.enter ? Object.keys(editing.graph).filter(id => id.startsWith(entry.enter)) : [entry.id];
  const roles = new Set();
  for (const id of ids) {
    const role = roleOf(id);
    if (role) roles.add(role);
    if ([...editing.checked.keys()].some(key => key.startsWith(`${id}.`))) roles.add('setting');
  }
  return [...roles];
}

function renderGraph() {
  const viewport = $('viewport');
  viewport.replaceChildren();
  const scope = editing.layout.scopes[editing.scope] || editing.layout.scopes[''];
  const byId = new Map(scope.nodes.map(entry => [entry.id, entry]));

  for (const group of scope.groups) {
    svg('rect', { x: group.pos[0], y: group.pos[1], width: group.size[0], height: group.size[1], rx: 6, fill: group.color || '#3f789e', 'fill-opacity': 0.22, stroke: group.color || '#3f789e', 'stroke-opacity': 0.5 }, viewport);
    const title = svg('text', { x: group.pos[0] + 10, y: group.pos[1] + 24, fill: '#ddd', 'font-size': 20 }, viewport);
    title.textContent = group.title;
  }

  const links = svg('g', {}, viewport);
  for (const entry of scope.nodes) {
    entry.drawnHeight = entry.kind === 'reroute' ? 0 : entry.kind === 'note' ? Math.max(60, entry.size[1]) : nodeRows(entry).height;
  }
  for (const link of scope.links) {
    const from = byId.get(link.from);
    const to = byId.get(link.to);
    if (!from || !to) continue;
    const [x1, y1] = from.kind === 'reroute' ? [from.pos[0] + 10, from.pos[1] + 10] : slotPoint(from, 'out', link.fromSlot);
    const [x2, y2] = to.kind === 'reroute' ? [to.pos[0] + 10, to.pos[1] + 10] : slotPoint(to, 'in', link.toSlot);
    const bend = Math.max(40, Math.abs(x2 - x1) / 2);
    svg('path', { d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`, fill: 'none', stroke: LINK_COLOURS[link.type] || '#9e9e9e', 'stroke-width': 3, 'stroke-opacity': 0.85 }, links);
  }

  for (const entry of scope.nodes) {
    drawNode(viewport, entry);
  }
  updateBreadcrumb();
  applyView();
}

function drawNode(viewport, entry) {
  const [x, y] = entry.pos;
  const width = entry.size[0];
  const group = svg('g', { class: 'node', 'data-id': entry.id, opacity: entry.mode === 2 ? 0.4 : 1 }, viewport);
  group.addEventListener('click', event => { event.stopPropagation(); selectNode(entry.id); });
  group.addEventListener('dblclick', event => { event.stopPropagation(); if (entry.enter) enterScope(entry.enter); });

  if (entry.kind === 'reroute') {
    svg('circle', { cx: x + 10, cy: y + 10, r: 7, fill: '#666' }, group);
    return;
  }
  if (entry.kind === 'note') {
    svg('rect', { x, y: y - TITLE_HEIGHT, width, height: entry.drawnHeight + TITLE_HEIGHT, rx: 6, fill: entry.bgcolor || '#433f2a', stroke: '#6b6440' }, group);
    svg('text', { x: x + 10, y: y - 8, fill: '#e8e0b0', 'font-size': 14 }, group).textContent = clip(entry.title, 40);
    clip(entry.text, 400).split('\n').slice(0, Math.floor(entry.drawnHeight / 18)).forEach((line, index) => {
      svg('text', { x: x + 10, y: y + 18 + index * 18, fill: '#d9d2a6', 'font-size': 13 }, group).textContent = clip(line, Math.floor(width / 7));
    });
    return;
  }
  const height = entry.drawnHeight;
  const roles = nodeRoles(entry);
  const selected = editing.selected === entry.id;
  const bypassed = entry.mode === 4;
  const outline = roles.find(role => role !== 'setting') || (roles.includes('setting') ? 'setting' : null);
  svg('rect', {
    x, y: y - TITLE_HEIGHT, width, height: height + TITLE_HEIGHT, rx: 8,
    fill: bypassed ? '#4a2f55' : entry.kind === 'io' ? '#2a3a2a' : entry.bgcolor || '#353535',
    stroke: selected ? '#ffffff' : outline ? ROLE_COLOURS[outline] : '#111',
    'stroke-width': selected || outline ? 4 : 1,
    'stroke-dasharray': entry.enter && outline ? '10 6' : 'none',
  }, group);
  svg('path', { d: `M${x},${y} v${-TITLE_HEIGHT + 8} a8,8 0 0 1 8,-8 h${width - 16} a8,8 0 0 1 8,8 v${TITLE_HEIGHT - 8} z`, fill: entry.color || (entry.enter ? '#264d73' : '#222'), 'pointer-events': 'none' }, group);
  // An untitled node shows its display name ("Load Image"), as in ComfyUI, rather than its class
  const title = entry.title === entry.type ? editing.objectInfo?.[entry.type]?.display_name || entry.title : entry.title;
  svg('text', { x: x + 10, y: y - 8, fill: '#eee', 'font-size': 14, 'font-weight': 'bold' }, group).textContent = clip(title, Math.floor(width / 8)) + (entry.enter ? '  ⧉' : '');

  // Badges above the title: what the node does in img2img
  const source = editing.sources.get(entry.id);
  const sourceGroup = source && sourceGroupList().find(group => group.group === source.group);
  const position = sourceGroup?.nodes.length > 1 ? ` #${sourceGroup.nodes.indexOf(entry.id) + 1}` : '';
  const names = { page: 'PAGE IMAGE', source: source?.label ? `SOURCE: ${source.label.toUpperCase()}${position}` : 'SOURCE', result: 'RESULT', setting: 'SETTINGS' };
  let badgeX = x;
  for (const role of roles) {
    const text = clip(names[role], 28);
    const badgeWidth = text.length * 7.5 + 14;
    svg('rect', { x: badgeX, y: y - TITLE_HEIGHT - 24, width: badgeWidth, height: 20, rx: 10, fill: ROLE_COLOURS[role] }, group);
    svg('text', { x: badgeX + 7, y: y - TITLE_HEIGHT - 10, fill: '#fff', 'font-size': 11, 'font-weight': 'bold' }, group).textContent = text;
    badgeX += badgeWidth + 6;
  }

  const rows = nodeRows(entry);
  (entry.inputs || []).forEach((slot, index) => {
    const [sx, sy] = slotPoint(entry, 'in', index);
    svg('circle', { cx: sx, cy: sy, r: 5, fill: LINK_COLOURS[slot.type] || '#9e9e9e' }, group);
    svg('text', { x: sx + 10, y: sy + 4, fill: '#bbb', 'font-size': 12 }, group).textContent = clip(slot.name, Math.floor(width / 16));
  });
  (entry.outputs || []).forEach((slot, index) => {
    const [sx, sy] = slotPoint(entry, 'out', index);
    svg('circle', { cx: sx, cy: sy, r: 5, fill: LINK_COLOURS[slot.type] || '#9e9e9e' }, group);
    svg('text', { x: sx - 10, y: sy + 4, fill: '#bbb', 'font-size': 12, 'text-anchor': 'end' }, group).textContent = clip(slot.name, Math.floor(width / 16));
  });
  let rowY = y + rows.slots * ROW + 4;
  for (const [name, value] of rows.widgets) {
    svg('rect', { x: x + 8, y: rowY, width: width - 16, height: ROW - 3, rx: 8, fill: '#222' }, group);
    svg('text', { x: x + 16, y: rowY + 13, fill: '#999', 'font-size': 12 }, group).textContent = clip(name, 18);
    svg('text', { x: x + width - 16, y: rowY + 13, fill: '#ddd', 'font-size': 12, 'text-anchor': 'end' }, group).textContent = clip(typeof value === 'object' ? JSON.stringify(value) : value, Math.max(6, Math.floor((width - 150) / 7)));
    rowY += ROW;
  }
  if (rows.thumbnail) {
    // The image the Load Image node uses, from ComfyUI's input folder, so similar nodes are easy to tell apart
    const file = imageFileOf(entry.id);
    const slash = file.lastIndexOf('/');
    const query = new URLSearchParams({ filename: file.slice(slash + 1), subfolder: slash >= 0 ? file.slice(0, slash) : '', type: 'input' });
    const image = svg('image', { href: `${comfyAddress}/view?${query}`, x: x + 8, y: rowY + 4, width: width - 16, height: THUMBNAIL, preserveAspectRatio: 'xMidYMid meet' }, group);
    image.addEventListener('error', () => image.remove()); // not in this ComfyUI's input folder
  }
}

function updateBreadcrumb() {
  const container = $('breadcrumb');
  container.replaceChildren();
  const parts = editing.scope ? editing.scope.slice(0, -1).split(':') : [];
  const crumbs = [['', 'Workflow']];
  for (let depth = 1; depth <= parts.length; depth++) {
    const prefix = `${parts.slice(0, depth).join(':')}:`;
    crumbs.push([prefix, editing.layout.scopes[prefix]?.title || 'Subgraph']);
  }
  crumbs.forEach(([prefix, title], index) => {
    if (index) container.append('›');
    const crumb = button(title, () => enterScope(prefix));
    crumb.disabled = prefix === editing.scope;
    container.append(crumb);
  });
}

function enterScope(prefix) {
  editing.scope = prefix;
  renderGraph();
  fitGraph();
  renderNodePanel();
}

function applyView() {
  $('viewport').setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
}

// The area the nodes take up. Notes are left out when there are other nodes: they're often parked far away.
function scopeBounds() {
  const scope = editing.layout.scopes[editing.scope] || editing.layout.scopes[''];
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  const working = scope.nodes.filter(entry => entry.kind !== 'note');
  for (const entry of working.length ? working : scope.nodes) {
    left = Math.min(left, entry.pos[0]);
    top = Math.min(top, entry.pos[1] - TITLE_HEIGHT - 26);
    right = Math.max(right, entry.pos[0] + entry.size[0]);
    bottom = Math.max(bottom, entry.pos[1] + (entry.drawnHeight || entry.size[1]));
  }
  for (const group of working.length ? [] : scope.groups) {
    left = Math.min(left, group.pos[0]);
    top = Math.min(top, group.pos[1]);
    right = Math.max(right, group.pos[0] + group.size[0]);
    bottom = Math.max(bottom, group.pos[1] + group.size[1]);
  }
  return Number.isFinite(left) ? { left, top, right, bottom } : { left: 0, top: 0, right: 100, bottom: 100 };
}

function fitGraph() {
  const box = $('graph').getBoundingClientRect();
  const bounds = scopeBounds();
  const margin = 40;
  const k = Math.min(1.2, (box.width - margin * 2) / (bounds.right - bounds.left), (box.height - margin * 2 - 30) / (bounds.bottom - bounds.top));
  view = { k, x: margin - bounds.left * k + (box.width - margin * 2 - (bounds.right - bounds.left) * k) / 2, y: margin + 30 - bounds.top * k };
  applyView();
}

function centreOn(nodeId) {
  const entry = editing.layout.scopes[editing.scope]?.nodes.find(node => node.id === nodeId);
  if (!entry) return;
  const box = $('graph').getBoundingClientRect();
  view.k = Math.max(view.k, 0.6);
  view.x = box.width / 2 - (entry.pos[0] + entry.size[0] / 2) * view.k;
  view.y = box.height / 2 - (entry.pos[1] + (entry.drawnHeight || 0) / 2) * view.k;
  applyView();
}

function zoomAt(factor, clientX, clientY) {
  const box = $('graph').getBoundingClientRect();
  const px = clientX - box.left;
  const py = clientY - box.top;
  const k = Math.min(3, Math.max(0.08, view.k * factor));
  view.x = px - (px - view.x) * (k / view.k);
  view.y = py - (py - view.y) * (k / view.k);
  view.k = k;
  applyView();
}

$('graph').addEventListener('wheel', event => {
  event.preventDefault();
  zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
}, { passive: false });
let drag = null;
let dragged = false;
$('graph').addEventListener('pointerdown', event => {
  drag = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y, moved: false };
  dragged = false;
});
$('graph').addEventListener('pointermove', event => {
  if (!drag) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) {
    drag.moved = true;
    // Captured only once it's a drag: Chrome sends the click to the capturing element, so capturing on
    // pointerdown would take every click away from the nodes
    $('graph').setPointerCapture(event.pointerId);
    $('graph').classList.add('panning');
  }
  if (!drag.moved) return;
  view.x = drag.viewX + dx;
  view.y = drag.viewY + dy;
  applyView();
});
$('graph').addEventListener('pointerup', () => {
  $('graph').classList.remove('panning');
  dragged = !!drag?.moved;
  drag = null;
});
// A click after a drag isn't a click; a click on the background clears the selection
$('graph').addEventListener('click', event => {
  if (dragged) {
    event.stopPropagation();
    return;
  }
  if (event.target.closest?.('.node')) return;
  selectNode(null);
}, true);
$('zoomIn').addEventListener('click', () => { const box = $('graph').getBoundingClientRect(); zoomAt(1.25, box.left + box.width / 2, box.top + box.height / 2); });
$('zoomOut').addEventListener('click', () => { const box = $('graph').getBoundingClientRect(); zoomAt(0.8, box.left + box.width / 2, box.top + box.height / 2); });
$('zoomFit').addEventListener('click', fitGraph);

// --- Settings list -----------------------------------------------------------------------------------------

// The ticked settings with up/down buttons: the popup shows them in this order
function renderOrder() {
  const keys = [...editing.checked.keys()];
  $('orderPanel').hidden = keys.length < 2;
  $('orderList').replaceChildren(...keys.map((key, index) => {
    const row = document.createElement('div');
    row.className = 'order-row';
    const label = document.createElement('span');
    label.className = 'order-label';
    label.textContent = editing.checked.get(key) || key;
    label.title = nodeLabel(key.slice(0, key.indexOf('.')));
    const move = (offset, text, title) => {
      const control = button(text, () => {
        const entries = [...editing.checked.entries()];
        [entries[index], entries[index + offset]] = [entries[index + offset], entries[index]];
        editing.checked = new Map(entries);
        renderOrder();
      });
      control.title = title;
      control.disabled = index + offset < 0 || index + offset >= keys.length;
      return control;
    };
    row.append(label, move(-1, '↑', 'Move up'), move(1, '↓', 'Move down'));
    return row;
  }));
}

function formatValue(value) {
  if (typeof value === 'string') return value.length > 80 ? `"${value.slice(0, 80)}…"` : `"${value}"`;
  return String(value);
}

// The inputs that can become settings, grouped by node; the image nodes' and output nodes' own aren't offered
// (they're replaced when it runs). With a node selected, only its inputs.
function renderCandidates() {
  const { graph, objectInfo } = editing;
  editing.candidates = settingCandidates(graph, objectInfo, { imageNode: editing.imageNode, outputs: [...outputNodeIds(graph, objectInfo), ...editing.sources.keys()] });
  const filter = $('settingsFilter').value.trim().toLowerCase();
  const only = editing.showAll ? null : editing.selected;
  const container = $('settingsList');
  container.replaceChildren();
  if (only) {
    const showAll = button('Show the inputs of every node', () => { editing.showAll = true; renderCandidates(); });
    showAll.className = 'link-like';
    container.append(showAll);
  }
  let lastNode = null;
  let rows = 0;
  for (const candidate of editing.candidates) {
    const key = `${candidate.node}.${candidate.input}`;
    if (only && candidate.node !== only) continue;
    const haystack = `${nodeLabel(candidate.node)} ${candidate.classType} ${candidate.input}`.toLowerCase();
    if (filter && !haystack.includes(filter) && !editing.checked.has(key)) continue;
    if (candidate.node !== lastNode) {
      lastNode = candidate.node;
      const heading = document.createElement('h3');
      heading.className = 'setting-group-title';
      heading.textContent = nodeLabel(candidate.node);
      heading.title = 'Show it in the workflow';
      heading.addEventListener('click', () => selectNode(candidate.node, true));
      container.append(heading);
    }
    const row = document.createElement('div');
    row.className = 'setting-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = editing.checked.has(key);
    const name = document.createElement('span');
    name.className = 'setting-input';
    name.textContent = candidate.input;
    const value = document.createElement('span');
    value.className = 'setting-value';
    value.textContent = formatValue(candidate.value);
    value.title = String(candidate.value);
    const label = document.createElement('input');
    label.type = 'text';
    label.maxLength = 40;
    label.placeholder = 'Name in the popup';
    label.value = editing.checked.get(key) ?? prettyInputName(candidate.input);
    label.disabled = !checkbox.checked;
    checkbox.addEventListener('change', () => {
      label.disabled = !checkbox.checked;
      if (checkbox.checked) {
        editing.checked.set(key, label.value);
        label.focus();
      } else {
        editing.checked.delete(key);
      }
      renderOrder();
      renderGraph();
    });
    label.addEventListener('input', () => {
      if (checkbox.checked) editing.checked.set(key, label.value);
      renderOrder();
    });
    row.append(checkbox, name, value, label);
    container.append(row);
    rows++;
  }
  if (!rows) {
    container.append(only ? 'This node has no inputs that can be settings.' : filter ? 'No inputs match.' : 'This workflow has no inputs that can be settings.');
  }
  renderOrder();
}

$('settingsFilter').addEventListener('input', () => {
  editing.showAll = true;
  renderCandidates();
});
$('cancelEdit').addEventListener('click', closeEditor);

$('saveWorkflow').addEventListener('click', async () => {
  const name = $('workflowName').value.trim();
  if (!name) {
    showError('Give the workflow a name.');
    $('workflowName').focus();
    return;
  }
  showError('');
  const { graph } = editing;
  const output = editing.outputs.find(item => item.node === editing.outputNode);
  // The ticked settings in their popup order, each with the control the popup shows for it
  const candidates = new Map(editing.candidates.map(candidate => [`${candidate.node}.${candidate.input}`, candidate]));
  const settings = [...editing.checked.keys()].filter(key => candidates.has(key)).map(key => {
    const { node, input, kind, min, max, step, integer, options, multiline, seed } = candidates.get(key);
    const label = editing.checked.get(key).trim() || prettyInputName(input);
    return Object.fromEntries(Object.entries({ node, input, label, kind, min, max, step, integer, options, multiline, seed }).filter(([, value]) => value !== undefined));
  });
  const definition = {
    id: editing.id || `cw_${Date.now().toString(36)}`,
    name,
    version: Date.now(),
    graph,
    imageNode: editing.imageNode,
    outputNode: editing.outputNode,
    outputInput: output.input,
    sourceNodes: sourceGroupList().flatMap(group => group.nodes.map(node => ({
      node,
      label: group.label.trim() || 'Source',
      batch: group.nodes.length === 1 && editing.sources.get(node).batch,
      ...(group.nodes.length > 1 || group.group !== node ? { group: group.group } : {}),
    }))),
    settings,
  };
  if (editing.savedLayout) {
    definition.layout = editing.savedLayout;
  }
  const list = workflows.some(item => item.id === definition.id)
    ? workflows.map(item => item.id === definition.id ? definition : item)
    : [...workflows, definition];
  if (await saveWorkflows(list)) {
    closeEditor();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.customWorkflows) {
    workflows = changes.customWorkflows.newValue || [];
    renderList();
  }
  if (changes.processingMode) {
    $('processingNotice').hidden = changes.processingMode.newValue === 'local';
  }
});

loadWorkflows();
