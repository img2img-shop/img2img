// The My workflows page: add the user's own ComfyUI workflows, choose where the page image goes in and where the
// result comes out, and which inputs become popup settings. The helpers are shared/custom-workflows.js's; the
// definitions are saved in chrome.storage.local customWorkflows (the popup and content script read them there).

// Marks a file exported from this page, so it imports as it is. The file is one ComfyUI opens too: the workflow
// as ComfyUI saved it where it was added from such a file, with the setup made here in its `extra` under this
// name, else the workflow's graph the way ComfyUI's Export (API) writes it, with the setup on its first node (see
// exportFile). Older exports had the marker and the whole definition at the top, which ComfyUI opened as an
// empty workflow; they still import.
const EXPORT_MARKER = 'img2imgWorkflow';
// Where the files of workflows added from a ComfyUI save are kept, { id: file }, apart from the definitions:
// only Export reads them, and the definitions are read wherever a workflow runs
const FILES_KEY = 'customWorkflowFiles';
// The popup's presets of each workflow, { id: [{ id, name, values }] }, values under the keys of customWorkflowValues
const PRESETS_KEY = 'customWorkflowPresets';

// Dark mode, shared with the popup and the other extension pages
document.querySelector('header').append(img2imgTheme.button('theme-toggle'));
const $ = id => document.getElementById(id);

let workflows = [];
// The workflow being edited (see startEditing). Its checked Map holds one entry per setting shown in the popup,
// `node.input` -> { label, min, max } (min and max only where a number's range is narrowed, see rangeFields),
// and its order is the order of the settings in the popup. A node's switch is in it too, as `bypass:node` ->
// { label, pass, mute } (see switchModes).
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

// Keeps the file a workflow was added from (a ComfyUI save), or forgets it where there's none
async function saveWorkflowFile(id, file) {
  try {
    const { [FILES_KEY]: files = {} } = await chrome.storage.local.get(FILES_KEY);
    if (file) files[id] = file;
    else delete files[id];
    await chrome.storage.local.set({ [FILES_KEY]: files });
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
      Object.assign(button('Replace file…', () => replaceWorkflow(definition)), { title: 'Load a changed version of this workflow from ComfyUI; its settings, their values and its presets stay' }),
      Object.assign(button('Export', () => exportWorkflow(definition)), { title: 'Save this workflow, its setup and its presets as a file: Add workflow… reads it back, and ComfyUI opens it too' }),
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

// The saved workflow the chosen file replaces, or null when it's added as a new one (see replaceWorkflow)
let replacing = null;

$('addWorkflow').addEventListener('click', () => {
  replacing = null;
  $('fileInput').click();
});

// A changed version of a saved workflow, straight from ComfyUI: the workflow keeps its id, so the popup's values
// and selection stay, and its setup is carried over to the nodes the new file still has
function replaceWorkflow(definition) {
  showError('');
  replacing = definition;
  $('fileInput').click();
}

$('fileInput').addEventListener('change', async event => {
  const file = event.target.files[0];
  const target = replacing;
  replacing = null;
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
  const exported = exportedDefinition(json);
  const comfyFile = savedWorkflowFile(json);
  if (exported && !comfyFile && !target) {
    importWorkflow(exported, file.name, null);
    return;
  }
  const objectInfo = await fetchObjectInfo();
  let parsed;
  try {
    // An export in ComfyUI's saved format is read as the workflow it holds now, which ComfyUI may have changed
    // and saved since; without ComfyUI to read it by, the graph it was exported with stands in
    parsed = exported && !(comfyFile && objectInfo) ? exportedGraph(exported, file.name) : parseComfyWorkflow(comfyFile || json, objectInfo);
  } catch (error) {
    showError(error.message);
    return;
  }
  if (exported && !target) {
    if (sameGraph(parsed.graph, exported.graph)) {
      importWorkflow(exported, file.name, comfyFile);
      return;
    }
    if (!isCompleteExport(exported)) {
      showError(`${file.name} isn't a complete img2img workflow export.`);
      return;
    }
  }
  // The setup to carry over: the saved workflow's whose file this replaces, or the file's own where the workflow
  // in it was changed after the export. That one is a new workflow, named after its file, with the popup's values
  // of the workflow it was exported from: Add workflow… never changes a saved workflow whose file was changed
  // (Replace file… is for that).
  const from = target || exported;
  const newName = file.name.replace(/(\.img2img-workflow)?\.json$/i, '');
  if (from) {
    const carried = carryWorkflowSetup(from, parsed.graph, objectInfo);
    const { imageNode, outputNode, sourceNodes, settings } = carried;
    startEditing({
      id: target?.id, name: target ? target.name : newName, graph: parsed.graph, layout: parsed.layout, comfyFile, objectInfo,
      // What couldn't be carried over is listed for a replaced file, where a saved workflow's setup is at stake. A
      // file added as a new workflow brings what still fits of the setup in it and says nothing of the rest: those
      // are the nodes its author took out, and the new workflow is set up below anyway.
      warnings: target ? [...parsed.warnings, ...carried.lost] : parsed.warnings, fileWarnings: parsed.warnings,
      imageNode, outputNode, sourceNodes, settings,
      // (a file added as a new workflow brings the presets in it, not those of a saved workflow with its id)
      carry: { from: from.id, values: carried.carryValues, presets: target ? undefined : filePresets(exported) },
      // (said for a replaced file only: a file added with its setup in it just opens set up, like any new workflow)
      notice: target
        ? `The new file is in. The setup of "${target.name}" is carried over below wherever the file has the same nodes; nothing changes until you save.`
        : undefined,
    });
    return;
  }
  startEditing({ name: newName, graph: parsed.graph, layout: parsed.layout, comfyFile, objectInfo, warnings: parsed.warnings, settings: [] });
});

// Whether two graphs are the same nodes, inputs and values, whatever order they are written in
function sameGraph(one, other) {
  const ordered = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : item);
  return ordered(one) === ordered(other);
}

// The presets in a file exported from this page, as they're kept (see PRESETS_KEY); none in an older export
function filePresets(definition) {
  if (!Array.isArray(definition?.presets)) return [];
  return definition.presets
    .filter(preset => preset && typeof preset.name === 'string' && preset.name.trim() && preset.values && typeof preset.values === 'object' && !Array.isArray(preset.values))
    .map((preset, index) => ({ id: typeof preset.id === 'string' && preset.id ? preset.id : `p_${Date.now().toString(36)}_${index}`, name: preset.name.trim(), values: { ...preset.values } }));
}

// Keeps a workflow's presets, or forgets them where there are none
async function savePresets(id, presets) {
  const { [PRESETS_KEY]: all = {} } = await chrome.storage.local.get(PRESETS_KEY);
  if (presets?.length) all[id] = presets;
  else delete all[id];
  await chrome.storage.local.set({ [PRESETS_KEY]: all });
}

// The workflow as ComfyUI saved it (nodes and links) in a file, without the setup an export from this page put
// in it, or null for a file in the API format
function savedWorkflowFile(json) {
  if (!json || !Array.isArray(json.nodes) || !Array.isArray(json.links)) return null;
  if (!json.extra || !(EXPORT_MARKER in json.extra)) return json;
  const { [EXPORT_MARKER]: _setup, ...extra } = json.extra;
  return { ...json, extra };
}

// The graph of a file exported from this page, when it replaces a saved workflow's (the file's own setup isn't
// used: the saved workflow's is carried over, as for any other file)
function exportedGraph(definition, fileName) {
  if (!definition.graph || typeof definition.graph !== 'object' || !Object.keys(definition.graph).length) {
    throw new Error(`${fileName} isn't a complete img2img workflow export.`);
  }
  return { graph: definition.graph, layout: definition.layout, warnings: [] };
}

// What Export saves, a file ComfyUI opens as the workflow it is. Where the workflow was added from a ComfyUI
// save, that file, with the definition in its `extra`, which ComfyUI keeps through its own saves: it opens there
// laid out and wired as it was saved (the layout is left out, being the file's own). Else the graph in the API
// format (every entry at the top a node, or ComfyUI takes the file for a saved workflow without nodes and opens
// an empty one), with the rest of the definition in the first node's _meta, where ComfyUI keeps a node's title
// and ignores anything else. ComfyUI lays an API file out by itself, and leaves out the links into inputs a node
// only grows as they are connected, so the saved file is the one to export wherever there is one.
function exportFile(definition, comfyFile) {
  if (comfyFile) {
    const { layout, ...setup } = definition;
    return { ...comfyFile, extra: { ...comfyFile.extra, [EXPORT_MARKER]: setup } };
  }
  const { graph, ...setup } = definition;
  const [first] = Object.keys(graph);
  return { ...graph, [first]: { ...graph[first], _meta: { ...graph[first]._meta, [EXPORT_MARKER]: setup } } };
}

// The definition in a file exported from this page (in any of its shapes, see EXPORT_MARKER), or null for any
// other file
function exportedDefinition(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (json[EXPORT_MARKER]) {
    const { [EXPORT_MARKER]: _marker, ...definition } = json;
    return definition;
  }
  const saved = savedWorkflowFile(json);
  if (saved) {
    const setup = json.extra?.[EXPORT_MARKER];
    return setup && typeof setup === 'object' ? { ...setup, layout: workflowLayout(saved) } : null;
  }
  const holder = Object.keys(json).find(id => json[id]?._meta?.[EXPORT_MARKER] && typeof json[id]._meta[EXPORT_MARKER] === 'object');
  if (!holder) return null;
  const { _meta: { [EXPORT_MARKER]: setup, ...meta }, ...node } = json[holder];
  if (Object.keys(meta).length) node._meta = meta;
  return { ...setup, graph: { ...json, [holder]: node } };
}

function isCompleteExport(definition) {
  return typeof definition.id === 'string' && typeof definition.name === 'string' && Boolean(definition.graph) && typeof definition.graph === 'object'
    && Boolean(definition.graph[definition.imageNode] && definition.graph[definition.outputNode]) && Array.isArray(definition.settings);
}

// A workflow exported from this page: added as it is (one with the same id is replaced), with the ComfyUI save
// it came in, where it came in one, and the presets that came with it (an older export, without any, leaves a
// workflow's own presets as they are)
async function importWorkflow(exported, fileName, comfyFile) {
  const { presets, ...definition } = exported;
  if (!isCompleteExport(definition)) {
    showError(`${fileName} isn't a complete img2img workflow export.`);
    return;
  }
  definition.version = Date.now();
  if (!(await saveWorkflowFile(definition.id, comfyFile))) return;
  if (Array.isArray(presets)) {
    try {
      await savePresets(definition.id, filePresets(exported));
    } catch (error) {
      showError(`Couldn't save: ${error.message}`);
      return;
    }
  }
  await saveWorkflows([...workflows.filter(item => item.id !== definition.id), definition]);
}

// The file has the workflow's presets in its setup, where it has any
async function exportWorkflow(definition) {
  const { [FILES_KEY]: files = {}, [PRESETS_KEY]: presets = {} } = await chrome.storage.local.get([FILES_KEY, PRESETS_KEY]);
  const setup = presets[definition.id]?.length ? { ...definition, presets: presets[definition.id] } : definition;
  const blob = new Blob([JSON.stringify(exportFile(setup, files[definition.id]), null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${definition.name.replace(/[\\/:*?"<>|]+/g, '_')}.img2img-workflow.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// Deleting a workflow takes its popup values and presets with it, and whatever still picks it: a rule in the
// settings that runs it on a site (the question says so, rather than leaving a rule that can't run anything) and
// the popup's own choice, which goes back to the default as the popup itself does when it's open at the time
async function deleteWorkflow(definition) {
  const stored = await chrome.storage.local.get(['customWorkflowValues', PRESETS_KEY, 'siteWorkflows', 'workflow']);
  const value = `${CUSTOM_WORKFLOW_PREFIX}${definition.id}`;
  const rules = Array.isArray(stored.siteWorkflows) ? stored.siteWorkflows : [];
  const ruled = rules.filter(rule => rule?.workflow === value);
  const note = ruled.length ? ` It runs on ${ruled.map(rule => rule.site).join(', ')} by a rule in the settings: the rule goes too.` : '';
  if (!confirm(`Delete "${definition.name}"?${note}`)) return;
  const customWorkflowValues = { ...stored.customWorkflowValues };
  delete customWorkflowValues[definition.id];
  const presets = { ...stored[PRESETS_KEY] };
  delete presets[definition.id];
  const changes = { customWorkflowValues, [PRESETS_KEY]: presets };
  if (ruled.length) changes.siteWorkflows = rules.filter(rule => rule?.workflow !== value);
  if (stored.workflow === value) changes.workflow = DEFAULT_WORKFLOW;
  await chrome.storage.local.set(changes);
  await saveWorkflowFile(definition.id, null);
  await saveWorkflows(workflows.filter(item => item.id !== definition.id));
  if (editing?.id === definition.id) closeEditor();
}

async function editWorkflow(definition) {
  showError('');
  const objectInfo = await fetchObjectInfo();
  const reread = objectInfo && await withNodesOffInFile(definition, objectInfo);
  if (reread) {
    startEditing(reread);
    return;
  }
  startEditing({ ...definition, objectInfo, warnings: [] });
}

// A workflow saved before nodes its file has muted or bypassed were kept in its graph (see uiWorkflowToApi) has
// none of them, so they couldn't be clicked: its file, kept with it, is read again as Replace file reads a new one,
// with the setup carried over, so they're there to set up. Null when there's nothing to bring in: no file kept (one
// added in the API format), or no node off in it that's installed. Nothing changes until it's saved, and the file
// kept with the workflow stays as it is.
async function withNodesOffInFile(definition, objectInfo) {
  if (Object.values(definition.graph || {}).some(node => node._meta?.mode)) return null;
  let file;
  try {
    ({ [FILES_KEY]: { [definition.id]: file } = {} } = await chrome.storage.local.get(FILES_KEY));
  } catch {
    return null;
  }
  if (!file) return null;
  let parsed;
  try {
    parsed = parseComfyWorkflow(file, objectInfo);
  } catch {
    return null;
  }
  if (!Object.values(parsed.graph).some(node => node._meta?.mode)) return null;
  const carried = carryWorkflowSetup(definition, parsed.graph, objectInfo);
  const { imageNode, outputNode, sourceNodes, settings } = carried;
  return {
    id: definition.id, name: definition.name, graph: parsed.graph, layout: parsed.layout, objectInfo,
    warnings: [...parsed.warnings, ...carried.lost], fileWarnings: parsed.warnings,
    imageNode, outputNode, sourceNodes, settings, carry: { from: definition.id, values: carried.carryValues },
    notice: 'The nodes muted or bypassed in this workflow\'s file can now be set up: click one to give it a switch in the popup. They stay off as the file has them until it\'s turned on there. Nothing changes until you save.',
  };
}

// carry: where the setup came from when it was carried over (the workflow's own replaced file, or another
// workflow for a new one), { from: id, values: fn, presets }: the popup's saved values and presets follow it when
// this is saved, those of the workflow `from` unless presets are given (a file's own).
// fileWarnings are the file's own, kept apart from the carry-over's so the setup can be chosen again.
// comfyFile is the file just read, where it's a ComfyUI save (null for one in the API format), kept with the
// workflow for Export; it's left undefined when a saved workflow is edited, whose file stays as it is.
function startEditing({ id, name, graph, layout, comfyFile, objectInfo, warnings, fileWarnings = warnings, imageNode, outputNode, sourceNodes = [], settings, carry = null, notice = '', setupFrom = '' }) {
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
    id, graph, comfyFile, objectInfo, imageNodes, outputs,
    layout: layout?.scopes ? layout : autoLayout(graph),
    savedLayout: layout?.scopes ? layout : null,
    scope: '',
    selected: null,
    // By default the page image goes into a Load Image node that doesn't feed a node together with others (those
    // are usually a set of sources, like a batch)
    imageNode: imageNodes.includes(imageNode) ? imageNode : defaultPageImage(graph, objectInfo, imageNodes),
    // By default the result comes from the output node at the end of the longest chain of work, not the first
    // one in the file (a workflow often saves a step on the way too)
    outputNode: outputs.some(output => output.node === outputNode) ? outputNode : defaultOutputNode(graph, objectInfo, outputs),
    // Load Image nodes that get a source from the popup: node -> { label, batch }
    // Load Image nodes that get a source from the popup: node -> { group, label, batch }. Nodes with the same group
    // share one picker and get its images in this Map's order.
    sources: new Map(sourceNodes.filter(source => imageNodes.includes(source.node)).map(source => [source.node, { group: source.group || source.node, label: source.label, batch: Boolean(source.batch) }])),
    // A setting's saved min and max are the range the popup used, which for an older definition is just the
    // node's own: renderCandidates shows them as a narrowed range only where they differ from the node's.
    checked: new Map(settings.map(setting => [settingKey(setting), setting.kind === 'bypass'
      ? { label: setting.label, pass: setting.pass, mute: Boolean(setting.mute) }
      : {
        label: setting.label, min: setting.min ?? undefined, max: setting.max ?? undefined,
        ...(setting.kind === 'pick' ? { style: setting.slider ? 'slider' : 'dropdown', choices: (setting.options || []).map((label, index) => ({ label, value: setting.values?.[index] ?? '' })) } : {}),
      }])),
    showAll: true,
    carry,
    fileWarnings,
  };
  // A new workflow: every other Load Image node gets a source, one picker per set of nodes feeding the same node
  // (a setup carried over brings its own sources)
  if (!id && !carry) {
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
  if (notice) box.append(Object.assign(document.createElement('p'), { textContent: notice }));
  if (notes.length) {
    box.append('Check before using it:');
    const list = document.createElement('ul');
    list.append(...notes.map(note => Object.assign(document.createElement('li'), { textContent: note })));
    box.append(list);
  }
  box.hidden = !notice && !notes.length;
  $('editorTitle').textContent = id ? `Edit "${name}"` : 'New workflow';
  $('workflowName').value = name;
  $('settingsFilter').value = '';
  renderSetupFrom(id, setupFrom);
  $('editorCard').hidden = false;
  renderEditor();
  fitGraph();
  $('editorCard').scrollIntoView({ behavior: 'smooth' });
}

// The "Set it up like" picker of a new workflow: a saved workflow whose setup is carried over to it
function renderSetupFrom(id, selected) {
  const select = $('setupFromSelect');
  select.replaceChildren(new Option('Nothing: start from scratch', ''), ...workflows.map(item => new Option(item.name, item.id)));
  select.value = selected;
  $('setupFrom').hidden = Boolean(id) || !workflows.length;
}

$('setupFromSelect').addEventListener('change', () => {
  const other = workflows.find(item => item.id === $('setupFromSelect').value);
  const { graph, savedLayout, comfyFile, objectInfo, fileWarnings } = editing;
  // (fileWarnings said apart: left out, startEditing would take this choice's notes for the file's own, and the next
  // choice would be listed on top of them)
  const base = { name: $('workflowName').value, graph, layout: savedLayout, comfyFile, objectInfo, warnings: fileWarnings, fileWarnings };
  if (!other) {
    startEditing({ ...base, settings: [] });
    return;
  }
  const carried = carryWorkflowSetup(other, graph, objectInfo);
  const { imageNode, outputNode, sourceNodes, settings } = carried;
  startEditing({
    ...base, imageNode, outputNode, sourceNodes, settings, warnings: [...fileWarnings, ...carried.lost],
    carry: { from: other.id, values: carried.carryValues }, setupFrom: other.id,
  });
});

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
      choice('source', 'Gets a source picked in the popup', '(a portrait, an object to add, a style reference...)'),
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
    panel.append(switchChoice(nodeId), Object.assign(document.createElement('div'), { className: 'muted', textContent: count ? 'Its inputs are listed below: tick the ones to show in the popup.' : 'It has no inputs that can be popup settings.' }));
  }
}

// A node's switch in the popup: off, the workflow runs without the node, bypassed or muted as in ComfyUI

const switchKey = nodeId => `${BYPASS_KEY_PREFIX}${nodeId}`;
// The node a ticked setting belongs to, from its key in editing.checked
const settingNode = key => key.startsWith(BYPASS_KEY_PREFIX) ? key.slice(BYPASS_KEY_PREFIX.length) : key.slice(0, key.indexOf('.'));

// The ways the node can be switched off, as in ComfyUI: { pass, mute }. pass is what it passes on when it's
// bypassed (bypassPlan), or null when it can't be; mute is whether it can be muted (canMute). Without the node's
// definition (ComfyUI isn't running), a bypass saved before keeps what was worked out then.
function switchModes(nodeId) {
  const { graph, objectInfo } = editing;
  const pass = objectInfo?.[graph[nodeId]?.class_type] ? bypassPlan(graph, objectInfo, nodeId) : editing.checked.get(switchKey(nodeId))?.pass ?? null;
  return { pass, mute: canMute(graph, nodeId) };
}

// A node's switch as it's saved: muted where that was chosen (or is the only way), else bypassed. Null when the
// node can't be switched off.
function switchSetting(nodeId, entry) {
  const { pass, mute } = switchModes(nodeId);
  const node = editing.graph[nodeId];
  const base = { node: nodeId, label: entry.label.trim() || node._meta?.title || node.class_type, kind: 'bypass' };
  if (mute && (entry.mute || !pass)) return { ...base, mute: true };
  return pass ? { ...base, pass } : null;
}

function switchChoice(nodeId) {
  const wrap = document.createElement('div');
  wrap.className = 'switch-options';
  const key = switchKey(nodeId);
  const { pass, mute } = switchModes(nodeId);
  if (!pass && !mute) {
    wrap.append(Object.assign(document.createElement('div'), {
      className: 'muted',
      textContent: editing.objectInfo?.[editing.graph[nodeId].class_type]
        ? "This node can't get an on/off switch in the popup: nothing in the workflow reads it."
        : 'Start ComfyUI and edit the workflow again to give this node an on/off switch in the popup.',
    }));
    return wrap;
  }
  const node = editing.graph[nodeId];
  // A node the workflow file has muted or bypassed: off as the file has it, unless its switch turns it on
  const offInFile = fileSwitchedOff(editing.graph, nodeId);
  const entry = editing.checked.get(key) ?? { label: node._meta?.title || node.class_type, mute: node._meta?.mode === 'muted' };
  const row = document.createElement('label');
  row.className = 'choice';
  const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox', id: 'nodeSwitch', checked: editing.checked.has(key) });
  row.append(checkbox, offInFile ? 'Can be switched on in the popup' : 'Can be switched off in the popup');
  row.append(Object.assign(document.createElement('span'), {
    className: 'muted',
    textContent: offInFile
      ? `(it's ${node._meta.mode} in the workflow, and stays off until it's switched on there)`
      : '(the workflow then runs without it)',
  }));
  const label = Object.assign(document.createElement('input'), { type: 'text', id: 'nodeSwitchName', maxLength: 40, value: entry.label, placeholder: 'Name in the popup', disabled: !checkbox.checked });
  // What off means, in ComfyUI's two ways; one the node can't do is shown but can't be picked
  entry.mute = mute && (Boolean(entry.mute) || !pass);
  const mode = (id, muted, possible, text, help) => {
    const line = document.createElement('label');
    line.className = 'choice switch-mode';
    const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'switchMode', id, checked: entry.mute === muted, disabled: !checkbox.checked || !possible });
    radio.dataset.possible = possible ? '1' : '';
    radio.addEventListener('change', () => { entry.mute = muted; });
    line.append(radio, text, Object.assign(document.createElement('span'), { className: 'muted', textContent: possible ? help : "(this node can't be)" }));
    return line;
  };
  const modes = [
    mode('switchBypass', false, Boolean(pass), 'Off, it is bypassed', '(what goes into it is passed on to the next node)'),
    mode('switchMute', true, mute, 'Off, it is muted', '(nothing comes out of it and what read it is left unconnected, as in ComfyUI)'),
  ];
  checkbox.addEventListener('change', () => {
    label.disabled = !checkbox.checked;
    for (const line of modes) {
      const radio = line.querySelector('input');
      radio.disabled = !checkbox.checked || !radio.dataset.possible;
    }
    if (checkbox.checked) {
      entry.label = label.value;
      entry.pass = pass;
      editing.checked.set(key, entry);
    } else {
      editing.checked.delete(key);
    }
    renderOrder();
    renderGraph();
  });
  label.addEventListener('input', () => {
    entry.label = label.value;
    renderOrder();
  });
  wrap.append(row, label, ...modes);
  return wrap;
}

// --- Drawing the workflow ----------------------------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg';
const TITLE_HEIGHT = 26;
const ROW = 20;
const THUMBNAIL = 130;
const LINK_COLOURS = { IMAGE: '#64b5f6', MASK: '#81c784', LATENT: '#ff9cf9', MODEL: '#b39ddb', CLIP: '#ffd500', VAE: '#ff6e6e', CONDITIONING: '#ffa931', INT: '#29b6f6', FLOAT: '#aed581', STRING: '#90a4ae' };
const ROLE_COLOURS = { page: '#43a047', source: '#ab47bc', result: '#1e88e5', setting: '#fb8c00', switch: '#00897b' };
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
    if (editing.checked.has(switchKey(id))) roles.add('switch');
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
  const outline = roles.find(role => role !== 'setting') || roles[0] || null;
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
  const names = { page: 'PAGE IMAGE', source: source?.label ? `SOURCE: ${source.label.toUpperCase()}${position}` : 'SOURCE', result: 'RESULT', setting: 'SETTINGS', switch: 'ON/OFF SWITCH' };
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
    label.textContent = editing.checked.get(key).label || key;
    label.title = `${nodeLabel(settingNode(key))}: show it in the workflow`;
    label.addEventListener('click', () => showSetting(key));
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
    // Dragged onto another row, it goes above or below it, whichever half it's dropped on
    const lowerHalf = event => { const box = row.getBoundingClientRect(); return event.clientY > box.top + box.height / 2; };
    row.draggable = true;
    row.addEventListener('dragstart', event => {
      orderDragged = key;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', label.textContent);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      orderDragged = null;
      clearOrderMarks();
    });
    row.addEventListener('dragover', event => {
      if (orderDragged === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const mark = lowerHalf(event) ? 'drop-after' : 'drop-before';
      if (row.classList.contains(mark)) return;
      clearOrderMarks(false);
      if (orderDragged !== key) row.classList.add(mark);
    });
    row.addEventListener('drop', event => {
      if (orderDragged === null) return;
      event.preventDefault();
      const dragged = orderDragged;
      orderDragged = null;
      if (dragged !== key && editing.checked.has(dragged)) {
        const entries = [...editing.checked.entries()];
        const [moved] = entries.splice(entries.findIndex(([item]) => item === dragged), 1);
        entries.splice(entries.findIndex(([item]) => item === key) + (lowerHalf(event) ? 1 : 0), 0, moved);
        editing.checked = new Map(entries);
      }
      renderOrder();
    });
    row.append(label, move(-1, '↑', 'Move up'), move(1, '↓', 'Move down'));
    return row;
  }));
}

// The setting being dragged in the order list (its key), and the marks that show where it would land
let orderDragged = null;
function clearOrderMarks(all = true) {
  for (const row of $('orderList').children) row.classList.remove('drop-before', 'drop-after', ...(all ? ['dragging'] : []));
}

// Shows a ticked setting where it's set up: its node selected in the workflow, the list down to that node's
// inputs, and the setting's own name box focused (a node's switch has its box in the node's panel)
function showSetting(key) {
  selectNode(settingNode(key), true);
  if (key.startsWith(BYPASS_KEY_PREFIX)) {
    $('nodeSwitchName')?.focus();
    return;
  }
  const row = [...$('settingsList').querySelectorAll('.setting-row')].find(item => item.dataset.key === key);
  if (!row) return;
  row.classList.add('shown');
  row.querySelector('input[type="text"]').focus();
}

function formatValue(value) {
  if (typeof value === 'string') return value.length > 80 ? `"${value.slice(0, 80)}…"` : `"${value}"`;
  return String(value);
}

// The lowest and highest value a number setting offers in the popup, which is the node's own range unless it's
// narrowed here. Nodes often allow far more than makes sense (a LoRA strength from -100 to 100 when -3 to 3 is
// the useful part), and a narrow enough range also gets a slider in the popup instead of a number box.
const RANGE_ENDS = [['min', 'lowest'], ['max', 'highest']];
function rangeFields(candidate, entry, checkbox) {
  const wrap = document.createElement('span');
  wrap.className = 'setting-range';
  const boxes = {};
  // The other end of the range as the popup would use it, so each end stays on its own side of the other
  const otherEnd = end => entry[end === 'min' ? 'max' : 'min'] ?? candidate[end === 'min' ? 'max' : 'min'];
  for (const [end, which] of RANGE_ENDS) {
    const box = document.createElement('input');
    boxes[end] = box;
    box.type = 'number';
    box.step = candidate.integer ? '1' : 'any';
    box.className = 'range-box';
    box.disabled = !checkbox.checked;
    box.placeholder = Number.isFinite(candidate[end]) ? String(candidate[end]) : end;
    box.title = `The ${which} value the popup offers${Number.isFinite(candidate[end]) ? ` (the node itself allows ${candidate[end]})` : ''}`;
    // The node's own limit isn't a narrowed range: an older definition saved it as the setting's own
    box.value = entry[end] === undefined || entry[end] === candidate[end] ? '' : entry[end];
    box.addEventListener('change', () => {
      entry[end] = rangeEnd(box.value, end, candidate, otherEnd(end));
      box.value = entry[end] ?? '';
    });
    wrap.append(box);
  }
  checkbox.addEventListener('change', () => {
    for (const box of Object.values(boxes)) box.disabled = !checkbox.checked;
  });
  return wrap;
}

// How a text setting shows in the popup: a box to type in, or a dropdown or a slider over choices written here
// (a slider steps through them in that order). Each choice is a label the popup shows and the text it puts into
// the input, which can be left empty when the label is the text. Returns the picker for the row's last column
// and the list of choices, which goes under the row.
const TEXT_STYLES = [['text', 'Text box'], ['dropdown', 'Dropdown'], ['slider', 'Slider']];
const isPickStyle = style => style === 'dropdown' || style === 'slider';
function textStyleFields(entry, checkbox) {
  const style = document.createElement('select');
  style.className = 'setting-style';
  style.title = 'How the popup shows this text';
  style.append(...TEXT_STYLES.map(([value, text]) => new Option(text, value)));
  style.value = isPickStyle(entry.style) ? entry.style : 'text';
  const words = document.createElement('div');
  words.className = 'setting-words';
  const hint = Object.assign(document.createElement('div'), { className: 'muted' });
  const list = document.createElement('div');
  const choiceRow = choice => {
    const row = document.createElement('div');
    row.className = 'choice-row';
    const label = Object.assign(document.createElement('input'), { type: 'text', className: 'choice-label', value: choice.label, placeholder: 'Label in the popup', spellcheck: false });
    const value = Object.assign(document.createElement('textarea'), { className: 'choice-value', rows: 1, value: choice.value, placeholder: 'Text it puts in (empty: the label itself)', spellcheck: false });
    label.addEventListener('input', () => { choice.label = label.value; });
    value.addEventListener('input', () => { choice.value = value.value; });
    const remove = button('×', () => {
      entry.choices.splice(entry.choices.indexOf(choice), 1);
      row.remove();
    }, 'choice-remove');
    remove.title = 'Remove this choice';
    row.append(label, value, remove);
    return row;
  };
  const add = button('Add a choice', () => {
    const choice = { label: '', value: '' };
    entry.choices.push(choice);
    list.append(choiceRow(choice));
    list.lastChild.querySelector('.choice-label').focus();
  });
  words.append(hint, list, add);
  const show = () => {
    style.disabled = !checkbox.checked;
    words.hidden = !isPickStyle(style.value);
    if (words.hidden) return;
    // Something to start from: two choices to fill in
    entry.choices ??= [];
    while (entry.choices.length < 2) entry.choices.push({ label: '', value: '' });
    if (list.children.length !== entry.choices.length) list.replaceChildren(...entry.choices.map(choiceRow));
    hint.textContent = `Each choice is a label the popup shows and the text it puts into this input. Leave the text empty where the label is the text. The popup puts None ahead of them, which leaves the input empty${style.value === 'slider' ? ': the slider goes from None through the first choice to the last' : ''}. A choice of your own called None takes its place, where you put it and with the text you give it.`;
    for (const control of words.querySelectorAll('input, textarea, button')) control.disabled = !checkbox.checked;
  };
  show();
  style.addEventListener('change', () => {
    entry.style = style.value;
    show();
    if (!words.hidden) words.querySelector('.choice-label').focus();
  });
  checkbox.addEventListener('change', show);
  return [style, words];
}

// One end of a typed range, kept usable: an empty or impossible box falls back to the node's own limit, and the
// value stays within the node's limits (ComfyUI refuses the workflow outright when a value is outside them).
function rangeEnd(typed, end, candidate, other) {
  if (String(typed).trim() === '') return undefined;
  let value = Number(typed);
  if (!Number.isFinite(value)) return undefined;
  if (candidate.integer) value = Math.round(value);
  if (Number.isFinite(candidate.min)) value = Math.max(candidate.min, value);
  if (Number.isFinite(candidate.max)) value = Math.min(candidate.max, value);
  if (Number.isFinite(other) && (end === 'min' ? value >= other : value <= other)) return undefined;
  return value;
}

// The inputs that can become settings, grouped by node; the image nodes' own and the terminal output nodes' own
// aren't offered (they're replaced when it runs). With a node selected, only its inputs.
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
    row.dataset.key = key;
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
    // The entry the checked Map holds for this setting. It stays the same object while the row is on the page,
    // so the label and the range boxes below write straight into it (unticking only takes it out of the Map,
    // so a setting ticked again keeps the label and range it had).
    const entry = editing.checked.get(key) ?? { label: prettyInputName(candidate.input), min: undefined, max: undefined };
    const label = document.createElement('input');
    label.type = 'text';
    label.maxLength = 40;
    label.placeholder = 'Name in the popup';
    label.value = entry.label;
    label.disabled = !checkbox.checked;
    checkbox.addEventListener('change', () => {
      label.disabled = !checkbox.checked;
      if (checkbox.checked) {
        entry.label = label.value;
        editing.checked.set(key, entry);
        label.focus();
      } else {
        editing.checked.delete(key);
      }
      renderOrder();
      renderGraph();
    });
    label.addEventListener('input', () => {
      entry.label = label.value;
      renderOrder();
    });
    row.append(checkbox, name, value, label, ...(candidate.kind === 'number' ? [rangeFields(candidate, entry, checkbox)]
      : candidate.kind === 'text' ? textStyleFields(entry, checkbox) : [document.createElement('span')]));
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
  // A dropdown or a slider needs something to choose besides None
  for (const [key, entry] of editing.checked) {
    if (candidates.get(key)?.kind === 'text' && isPickStyle(entry.style) && !pickChoices(entry.choices).options.length) {
      showError(`Give "${entry.label.trim() || prettyInputName(candidates.get(key).input)}" at least one choice, or make it a text box.`);
      return;
    }
  }
  const settings =[...editing.checked.keys()].filter(key => candidates.has(key) || key.startsWith(BYPASS_KEY_PREFIX)).map(key => {
    if (key.startsWith(BYPASS_KEY_PREFIX)) {
      // A node's switch, with the way it's off
      const node = settingNode(key);
      return roleOf(node) ? null : switchSetting(node, editing.checked.get(key));
    }
    const candidate = candidates.get(key);
    const { node, input, kind, step, integer, options, multiline, seed } = candidate;
    const entry = editing.checked.get(key);
    const label = entry.label.trim() || prettyInputName(input);
    if (kind === 'text' && isPickStyle(entry.style)) {
      return { node, input, label, kind: 'pick', ...pickChoices(entry.choices), ...(entry.style === 'slider' ? { slider: true } : {}) };
    }
    // The range the popup offers: the one set here, else the node's own
    const [min, max] = RANGE_ENDS.map(([end]) => entry[end] ?? candidate[end]);
    return Object.fromEntries(Object.entries({ node, input, label, kind, min, max, step, integer, options, multiline, seed }).filter(([, value]) => value !== undefined));
  }).filter(Boolean);
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
  // A setup carried over brings the popup's saved values and presets along, under the nodes they belong to now;
  // they go in first so the popup finds them when it sees the workflow change
  if (editing.carry) {
    try {
      const { customWorkflowValues = {}, [PRESETS_KEY]: presets = {} } = await chrome.storage.local.get(['customWorkflowValues', PRESETS_KEY]);
      customWorkflowValues[definition.id] = editing.carry.values(customWorkflowValues[editing.carry.from]);
      const carriedPresets = (editing.carry.presets || presets[editing.carry.from] || []).map(preset => ({ ...preset, values: editing.carry.values(preset.values) }));
      await chrome.storage.local.set({ customWorkflowValues });
      await savePresets(definition.id, carriedPresets);
    } catch (error) {
      showError(`Couldn't save: ${error.message}`);
      return;
    }
  }
  if (editing.comfyFile !== undefined && !(await saveWorkflowFile(definition.id, editing.comfyFile))) return;
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
