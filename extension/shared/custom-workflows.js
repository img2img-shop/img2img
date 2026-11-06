// The user's own ComfyUI workflows ("My workflows"): uploaded on the workflows page (workflows.html), run only on
// the user's own ComfyUI (local mode). Loaded as a plain script after shared/workflows.js by the content script,
// the popup and the workflows page; the server tests require() it.
//
// A saved workflow is a definition:
//   { id, name, version, graph,          // graph: ComfyUI API format ({ nodeId: { class_type, inputs } })
//     imageNode,                          // the Load Image node that gets the page image
//     outputNode, outputInput,            // the output node whose image is the result, and its image input
//                                         // (nodes the result doesn't need are left out when it runs; older
//                                         // definitions also have dropNodes, no longer used)
//     sourceNodes: [{ node, label, batch, group }],  // Load Image nodes that get a source picked in the popup.
//                                         // Nodes with the same group share one picker: the first gets the
//                                         // source's first image, the second its second, and so on (its last
//                                         // image again when it has fewer). A node on its own gets the first
//                                         // image, or with batch on all of them as a batch. group defaults to node.
//     settings: [{ node, input, label, kind, min, max, step, options, multiline, seed }],  // shown in the popup,
//                                                                                        // in this order
//     layout }                            // how ComfyUI showed it (workflowLayout), for the workflows page
// The popup saves the values of those settings in customWorkflowValues[id]["node.input"], for a seed whether
// it's a new random one each time in customWorkflowValues[id]["node.input:random"], and the source picked for a
// source picker in customWorkflowValues[id]["source:group"] (unset: the source selected in the popup's grid).

const CUSTOM_WORKFLOW_PREFIX = 'custom:';
const CUSTOM_WORKFLOW_INPUT_GATE = 'img2img-input-gate';
const CUSTOM_WORKFLOW_RESULT_GATE = 'img2img-result-gate';
const CUSTOM_WORKFLOW_SOURCE_GATE = 'img2img-source-gate'; // one per source image: `${this}:${node}:${index}`

function isCustomWorkflow(workflow) {
  return typeof workflow === 'string' && workflow.startsWith(CUSTOM_WORKFLOW_PREFIX);
}

function customWorkflowId(workflow) {
  return isCustomWorkflow(workflow) ? workflow.slice(CUSTOM_WORKFLOW_PREFIX.length) : null;
}

const isLink = value => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]);
const inputSpecs = info => ({ ...info?.input?.required, ...info?.input?.optional });
// A dynamic combo option's own inputs (its inputs are under "inputs", a node's under "input")
const optionSpecs = option => ({ ...option?.inputs?.required, ...option?.inputs?.optional });

// Input types the ComfyUI frontend shows as widgets (they have a value in widgets_values); everything else is a
// socket. A list type is a combo.
const WIDGET_TYPES = ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO', 'COMFY_DYNAMICCOMBO_V3'];
function isWidgetSpec(spec) {
  const [type, config = {}] = spec || [];
  return (Array.isArray(type) || WIDGET_TYPES.includes(type)) && !config.forceInput && !config.socketless;
}

// Frontend-only nodes that never reach the server: notes are dropped, reroutes and primitives are wired through
const UI_ONLY_NODES = ['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode'];
const MODE_MUTED = 2;
const MODE_BYPASSED = 4;

// Whether a socket of type `a` connects to one of type `b`, as LiteGraph decides it: '*' or no type fits anything,
// and "A,B" lists fit when they share a type
function typesConnect(a, b) {
  if (!a || a === '*' || !b || b === '*' || a === b) return true;
  const [left, right] = [a, b].map(type => String(type).toLowerCase().split(','));
  return left.some(type => right.includes(type));
}

// The input a bypassed node passes on in place of output `slot` (carrying `type`), the way ComfyUI's frontend picks
// it: the input in the same slot when its type fits, else the first of exactly that type, else the first that fits.
// -1 when none does. (Not "the first of the type": a bypassed ControlNet apply would pass positive on as negative.)
function bypassedInput(node, slot, type) {
  const inputs = node.inputs || [];
  if (!type || type === '*') return inputs.length > slot ? slot : 0;
  const fits = input => typesConnect(input.type, node.outputs?.[slot]?.type) && typesConnect(input.type, type);
  if (inputs[slot] && fits(inputs[slot])) return slot;
  const exact = inputs.findIndex(input => input.type === type);
  return exact >= 0 ? exact : inputs.findIndex(fits);
}

// Read an uploaded workflow file: ComfyUI's API export as it is, or a saved workflow (nodes and links)
// converted with the installed nodes' definitions (ComfyUI's /object_info). Returns { graph, format, warnings },
// and for a saved workflow its layout (workflowLayout).
function parseComfyWorkflow(json, objectInfo) {
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const entries = Object.values(json);
    if (entries.length && entries.every(node => node && typeof node.class_type === 'string' && node.inputs && typeof node.inputs === 'object')) {
      return { graph: json, format: 'api', warnings: [] };
    }
    if (Array.isArray(json.nodes) && Array.isArray(json.links)) {
      if (!objectInfo) {
        throw new Error('Reading a saved workflow needs ComfyUI running (to look up its nodes). Start ComfyUI, or use Export (API) in ComfyUI.');
      }
      return { ...uiWorkflowToApi(json, objectInfo), layout: workflowLayout(json), format: 'ui' };
    }
  }
  throw new Error("This isn't a ComfyUI workflow: use a workflow saved from ComfyUI, or its Export (API) file.");
}

// A saved workflow (the frontend's graph: nodes, links, subgraphs) to the API format the server runs, the way
// the frontend's "Export (API)" does it: subgraphs are flattened, notes dropped, reroutes and primitive nodes
// wired through, muted nodes removed and bypassed ones skipped over.
function uiWorkflowToApi(ui, objectInfo) {
  const warnings = [];
  const subgraphs = new Map((ui.definitions?.subgraphs || []).map(subgraph => [subgraph.id, subgraph]));
  const graph = {};
  // Where each node output really comes from, once reroutes, primitives, bypasses and subgraph boundaries are
  // followed: a link [apiNodeId, slot], or { value } for a primitive's value. Memoised per scope.
  const resolved = new Map();

  // Links come as arrays [id, origin, originSlot, target, targetSlot, type] at the top level, and as objects in
  // subgraphs
  const linkIndex = links => new Map(links.map(link => Array.isArray(link)
    ? [link[0], { origin: link[1], originSlot: link[2], target: link[3], targetSlot: link[4], type: link[5] }]
    : [link.id, { origin: link.origin_id, originSlot: link.origin_slot, target: link.target_id, targetSlot: link.target_slot, type: link.type }]));

  // scope: { prefix, nodes (id -> node), links, parent: { scope, instance } } where instance is the subgraph
  // node in the parent scope
  function makeScope(nodes, links, prefix, parent) {
    return { prefix, nodes: new Map(nodes.map(node => [node.id, node])), links: linkIndex(links), parent };
  }

  // What feeds input slot `slot` of node `nodeId` in `scope`: null when nothing is connected
  function sourceOfInput(scope, nodeId, slot) {
    const node = scope.nodes.get(nodeId);
    const linkId = node?.inputs?.[slot]?.link;
    if (linkId === null || linkId === undefined) return null;
    const link = scope.links.get(linkId);
    return link ? sourceOfOutput(scope, link.origin, link.originSlot, link.type) : null;
  }

  // What output `slot` of node `nodeId` in `scope` really is
  function sourceOfOutput(scope, nodeId, slot, type) {
    const key = `${scope.prefix}|${nodeId}|${slot}`;
    if (resolved.has(key)) return resolved.get(key);
    resolved.set(key, null); // cycles resolve to nothing
    let result = null;
    if (nodeId === -10) {
      // A subgraph's input: whatever feeds the input of the same name on the subgraph node outside (the node
      // doesn't always list all of them, so not by position)
      const { scope: outer, instance } = scope.parent;
      const name = subgraphs.get(instance.type).inputs?.[slot]?.name;
      const outerSlot = (instance.inputs || []).findIndex(input => input.name === name);
      result = outerSlot >= 0 ? sourceOfInput(outer, instance.id, outerSlot) : null;
    } else {
      const node = scope.nodes.get(nodeId);
      if (!node || node.mode === MODE_MUTED) {
        result = null;
      } else if (node.type === 'Reroute') {
        result = sourceOfInput(scope, nodeId, 0);
      } else if (node.type === 'PrimitiveNode') {
        result = { value: node.widgets_values?.[0] };
      } else if (node.mode === MODE_BYPASSED) {
        const index = bypassedInput(node, slot, type ?? node.outputs?.[slot]?.type);
        result = index >= 0 ? sourceOfInput(scope, nodeId, index) : null;
      } else if (subgraphs.has(node.type)) {
        // A subgraph node: the inner link that ends at that output of the subgraph
        const inner = subgraphScope(scope, node);
        const link = [...inner.links.values()].find(l => l.target === -20 && l.targetSlot === slot);
        result = link ? sourceOfOutput(inner, link.origin, link.originSlot, link.type) : null;
      } else {
        result = [`${scope.prefix}${nodeId}`, slot];
      }
    }
    resolved.set(key, result);
    return result;
  }

  const subgraphScopes = new Map();
  function subgraphScope(scope, instance) {
    const key = `${scope.prefix}${instance.id}`;
    if (!subgraphScopes.has(key)) {
      const definition = subgraphs.get(instance.type);
      subgraphScopes.set(key, makeScope(definition.nodes || [], definition.links || [], `${key}:`, { scope, instance }));
    }
    return subgraphScopes.get(key);
  }

  // The widget values of a node by input name, in the frontend's order: widget inputs in definition order, a
  // seed's "control after generate" and an image upload button take an extra slot, a dynamic combo is followed
  // by the inputs of its chosen option. A widget the file has no value for (added in a newer version of the
  // node) gets its default, as the frontend does.
  function widgetValues(node, info) {
    const values = {};
    const raw = node.widgets_values;
    if (raw && !Array.isArray(raw) && typeof raw === 'object') {
      return { ...raw }; // some nodes save their widgets by name
    }
    const list = raw || [];
    let index = 0;
    const take = (name, spec) => {
      const [type, config = {}] = spec;
      if (index < list.length) {
        values[name] = list[index++];
      } else if (config.default !== undefined || Array.isArray(type)) {
        values[name] = config.default ?? type[0];
        return;
      } else {
        return;
      }
      // The frontend gives every INT named seed or noise_seed a "control after generate", unless its spec says
      // otherwise (KSampler (Efficient)'s seed doesn't ask for one but has it)
      const control = config.control_after_generate ?? (type === 'INT' && ['seed', 'noise_seed'].includes(name.split('.').pop()));
      if ((type === 'INT' || type === 'FLOAT') && control) index++;
      if (config.image_upload || config.video_upload || config.audio_upload) index++;
      if (type === 'COMFY_DYNAMICCOMBO_V3') {
        const option = (config.options || []).find(o => o.key === values[name]);
        for (const [child, childSpec] of Object.entries(optionSpecs(option))) {
          if (isWidgetSpec(childSpec)) take(`${name}.${child}`, childSpec);
        }
      }
    };
    for (const [name, spec] of Object.entries(inputSpecs(info))) {
      if (isWidgetSpec(spec)) take(name, spec);
    }
    return values;
  }

  function addNodes(scope) {
    for (const node of scope.nodes.values()) {
      if (UI_ONLY_NODES.includes(node.type) || node.mode === MODE_MUTED || node.mode === MODE_BYPASSED) continue;
      if (subgraphs.has(node.type)) {
        addNodes(subgraphScope(scope, node));
        continue;
      }
      const info = objectInfo[node.type];
      if (!info) {
        warnings.push(`${node.title || node.type} (${node.type}) isn't installed in ComfyUI`);
      }
      const inputs = widgetValues(node, info);
      (node.inputs || []).forEach((input, slot) => {
        const source = sourceOfInput(scope, node.id, slot);
        if (source === null) return; // unconnected: keeps its widget value, if it has one
        inputs[input.widget?.name ?? input.name] = Array.isArray(source) ? source : source.value;
      });
      graph[`${scope.prefix}${node.id}`] = { inputs, class_type: node.type, _meta: { title: node.title || info?.display_name || node.type } };
    }
  }

  addNodes(makeScope(ui.nodes, ui.links, '', null));
  if (!Object.keys(graph).length) {
    throw new Error('This workflow has no nodes that run');
  }
  return { graph, warnings };
}

// How ComfyUI shows a saved workflow, for drawing it on the workflows page: per scope (the top level, keyed '',
// and each subgraph node's inside, keyed by its node id prefix as in the API graph, e.g. '170:'), the nodes with
// their position, size, colours and slots, the links and the groups. A node's id is its API graph id; a subgraph
// node has `enter` (the scope of its inside), and a subgraph's own inputs and outputs are the nodes
// `${prefix}in` and `${prefix}out`.
function workflowLayout(ui) {
  const subgraphs = new Map((ui.definitions?.subgraphs || []).map(subgraph => [subgraph.id, subgraph]));
  const scopes = {};
  const slotList = slots => (slots || []).map(slot => ({ name: slot.label || slot.localized_name || slot.name || '', type: slot.type }));
  const box = bounding => Array.isArray(bounding) ? { pos: [bounding[0], bounding[1]], size: [bounding[2], bounding[3]] } : { pos: [0, 0], size: [120, 60] };

  function addScope(prefix, title, nodes, links, subgraph, depth) {
    const scope = { title, nodes: [], links: [], groups: [] };
    scopes[prefix] = scope;
    const id = nodeId => nodeId === -10 ? `${prefix}in` : nodeId === -20 ? `${prefix}out` : `${prefix}${nodeId}`;
    if (subgraph) {
      scope.nodes.push({ id: `${prefix}in`, kind: 'io', title: 'Inputs', ...box(subgraph.inputNode?.bounding), inputs: [], outputs: slotList(subgraph.inputs) });
      scope.nodes.push({ id: `${prefix}out`, kind: 'io', title: 'Outputs', ...box(subgraph.outputNode?.bounding), inputs: slotList(subgraph.outputs), outputs: [] });
    }
    for (const node of nodes || []) {
      const inner = subgraphs.get(node.type);
      const entry = {
        id: id(node.id), title: node.title || inner?.name || node.type, type: node.type, mode: node.mode || 0,
        pos: node.pos ? [Number(node.pos[0] ?? node.pos['0']), Number(node.pos[1] ?? node.pos['1'])] : [0, 0],
        size: node.size ? [Number(node.size[0] ?? node.size['0']), Number(node.size[1] ?? node.size['1'])] : [200, 80],
        color: node.color, bgcolor: node.bgcolor, inputs: slotList(node.inputs), outputs: slotList(node.outputs),
        kind: inner ? 'subgraph' : node.type === 'Note' || node.type === 'MarkdownNote' ? 'note' : node.type === 'Reroute' ? 'reroute' : 'node',
      };
      if (entry.kind === 'note') entry.text = String(node.widgets_values?.[0] ?? '');
      if (inner && depth < 8) {
        entry.enter = `${prefix}${node.id}:`;
        addScope(entry.enter, entry.title, inner.nodes, inner.links, inner, depth + 1);
      }
      scope.nodes.push(entry);
    }
    for (const link of links || []) {
      const [from, fromSlot, to, toSlot, type] = Array.isArray(link)
        ? [link[1], link[2], link[3], link[4], link[5]]
        : [link.origin_id, link.origin_slot, link.target_id, link.target_slot, link.type];
      scope.links.push({ from: id(from), fromSlot, to: id(to), toSlot, type });
    }
    scope.groups = (subgraph ? subgraph.groups : ui.groups || []).map(group => ({ title: group.title || '', color: group.color, ...box(group.bounding) }));
  }

  addScope('', 'Workflow', ui.nodes, ui.links, null, 0);
  return { scopes };
}

// A left-to-right layout for an API export (it has no positions): each node one column right of the nodes it
// reads from, in the same shape as workflowLayout's
function autoLayout(graph) {
  const column = new Map();
  const columnOf = (id, seen = new Set()) => {
    if (column.has(id)) return column.get(id);
    if (seen.has(id) || !graph[id]) return 0;
    seen.add(id);
    const sources = Object.values(graph[id].inputs).filter(isLink).map(([from]) => from);
    const value = sources.length ? 1 + Math.max(...sources.map(from => columnOf(from, seen))) : 0;
    column.set(id, value);
    return value;
  };
  const rows = new Map();
  const nodes = Object.entries(graph).map(([id, node]) => {
    const x = columnOf(id);
    const widgets = Object.values(node.inputs).filter(value => !isLink(value)).length;
    const links = Object.values(node.inputs).filter(isLink).length;
    // (an image loader also shows its image: see the workflows page)
    const height = 30 + 20 * (Math.max(links, 1) + widgets) + (/load.*image|image.*load/i.test(node.class_type) ? 140 : 0);
    const y = rows.get(x) || 0;
    rows.set(x, y + height + 60);
    return {
      id, title: node._meta?.title || node.class_type, type: node.class_type, mode: 0, kind: 'node',
      pos: [x * 320, y], size: [260, height],
      inputs: Object.entries(node.inputs).filter(([, value]) => isLink(value)).map(([name]) => ({ name })),
      outputs: [{ name: '' }],
    };
  });
  const links = [];
  for (const [id, node] of Object.entries(graph)) {
    Object.entries(node.inputs).filter(([, value]) => isLink(value)).forEach(([, [from, slot]], toSlot) => {
      links.push({ from, fromSlot: 0, to: id, toSlot, type: '', fromOutput: slot });
    });
  }
  return { scopes: { '': { title: 'Workflow', nodes, links, groups: [] } } };
}

// Nodes that can take the page image: image loaders with no connected inputs (LoadImage and the like)
function imageInputNodes(graph, objectInfo) {
  return Object.entries(graph).filter(([, node]) => {
    const info = objectInfo?.[node.class_type];
    const loadsImage = /load.*image|image.*load/i.test(node.class_type) && (!info || info.output?.[0] === 'IMAGE');
    return loadsImage && !Object.values(node.inputs).some(isLink);
  }).map(([id]) => id);
}

// Output nodes whose image could be the result, as [{ node, input }]: an output node (SaveImage, PreviewImage...)
// with a connected image input
function imageOutputNodes(graph, objectInfo) {
  const outputs = [];
  for (const [id, node] of Object.entries(graph)) {
    const info = objectInfo?.[node.class_type];
    const isOutput = info ? info.output_node : /save|preview/i.test(node.class_type);
    if (!isOutput) continue;
    const specs = inputSpecs(info);
    const input = Object.keys(node.inputs).find(name => isLink(node.inputs[name]) && (info ? specs[name]?.[0] === 'IMAGE' : /image/i.test(name)));
    if (input) outputs.push({ node: id, input });
  }
  return outputs;
}

// All output nodes (they're left out when the workflow runs, except the chosen one)
function outputNodeIds(graph, objectInfo) {
  return Object.entries(graph).filter(([, node]) => objectInfo?.[node.class_type]?.output_node || /^(SaveImage|PreviewImage)$/.test(node.class_type)).map(([id]) => id);
}

// The inputs that can become popup settings: every value that isn't a link, on nodes that run, except the page
// image loader's and the output nodes' own (file names, prefixes). Each comes with the control it would get.
function settingCandidates(graph, objectInfo, { imageNode, outputs = [] } = {}) {
  // Every image loader's inputs are left out too: its file is the page image or a source, or stays as it is (a
  // list of the files in ComfyUI's input folder is no use in the popup)
  const skip = new Set([imageNode, ...outputs, ...imageInputNodes(graph, objectInfo)]);
  const candidates = [];
  for (const [id, node] of Object.entries(graph)) {
    if (skip.has(id)) continue;
    const specs = inputSpecs(objectInfo?.[node.class_type]);
    for (const [name, value] of Object.entries(node.inputs)) {
      if (isLink(value)) continue;
      const control = describeSettingInput(specs[name] ?? dynamicChildSpec(specs, name), value, name);
      if (control) {
        candidates.push({ node: id, input: name, nodeTitle: node._meta?.title || node.class_type, classType: node.class_type, value, ...control });
      }
    }
  }
  return candidates;
}

// The spec of a dynamic combo's child input ("resize_type.width")
function dynamicChildSpec(specs, name) {
  const [parent, child] = name.split('.');
  if (!child || specs[parent]?.[0] !== 'COMFY_DYNAMICCOMBO_V3') return undefined;
  for (const option of specs[parent][1]?.options || []) {
    const spec = optionSpecs(option)[child];
    if (spec) return spec;
  }
  return undefined;
}

// The popup control for an input: { kind: number | choice | toggle | text, ... }, from its ComfyUI spec, or from
// the value alone when the node isn't installed. Null for values the popup can't edit. A seed (an integer named
// like one) can also be a new random number each time.
function describeSettingInput(spec, value, name = '') {
  const [type, config = {}] = spec || [];
  if (Array.isArray(type) || type === 'COMBO') {
    const options = Array.isArray(type) ? type : (config.options || []);
    return options.length ? { kind: 'choice', options } : null;
  }
  if (type === 'COMFY_DYNAMICCOMBO_V3') {
    return null; // changing it changes which other inputs exist
  }
  if (type === 'INT' || type === 'FLOAT') {
    const control = { kind: 'number', min: config.min ?? null, max: config.max ?? null, step: config.step ?? (type === 'INT' ? 1 : 0.01), integer: type === 'INT' };
    // Only by name: control_after_generate alone isn't enough, the core Int primitive declares it too
    if (type === 'INT' && SEED_NAME.test(name)) control.seed = true;
    return control;
  }
  if (type === 'BOOLEAN' || typeof value === 'boolean') {
    return { kind: 'toggle' };
  }
  if (type === 'STRING' || typeof value === 'string') {
    return { kind: 'text', multiline: Boolean(config.multiline) || (typeof value === 'string' && value.length > 60) };
  }
  if (typeof value === 'number') {
    const control = { kind: 'number', min: null, max: null, step: Number.isInteger(value) ? 1 : 0.01, integer: Number.isInteger(value) };
    if (control.integer && SEED_NAME.test(name)) control.seed = true;
    return control;
  }
  return null;
}

const SEED_NAME = /(^|_)seed$/i;
// Random seeds stay below 2^50, well within what JSON numbers carry exactly
const RANDOM_SEED_LIMIT = 2 ** 50;

// The key of a seed setting's "new random seed each time" choice in customWorkflowValues
function randomSeedKey(setting) {
  return `${setting.node}.${setting.input}:random`;
}

function randomSeed(setting) {
  const low = Math.max(0, setting.min ?? 0);
  const high = Math.min(setting.max ?? RANDOM_SEED_LIMIT, RANDOM_SEED_LIMIT);
  return low + Math.floor(Math.random() * (high - low + 1));
}

// A saved value for a setting, checked against its control: out-of-range numbers are clamped, unknown choices
// and wrong types fall back to the workflow's own value
function settingValue(setting, saved, fallback) {
  if (saved === undefined || saved === null) return fallback;
  switch (setting.kind) {
    case 'number': {
      let number = Number(saved);
      if (!Number.isFinite(number)) return fallback;
      if (setting.integer) number = Math.round(number);
      if (setting.min !== null && setting.min !== undefined) number = Math.max(setting.min, number);
      if (setting.max !== null && setting.max !== undefined) number = Math.min(setting.max, number);
      return number;
    }
    case 'choice':
      return setting.options.includes(saved) ? saved : fallback;
    case 'toggle':
      return typeof saved === 'boolean' ? saved : fallback;
    case 'text':
      return typeof saved === 'string' ? saved : fallback;
    default:
      return fallback;
  }
}

// The graph to run: the page image in the image loader, the picked sources' images in the source nodes, the
// popup's values applied, only the chosen output (as a PreviewImage, so nothing is written to ComfyUI's output
// folder) and the NSFW gate on the page image, every source image and the result (img2img is SFW-only; a custom
// graph can generate anything, so the result is checked too). sourceImages: { node: [base64, ...] }.
function buildCustomWorkflow(definition, targetImage, values, nsfw, sourceImages = {}) {
  const graph = neededNodes(JSON.parse(JSON.stringify(definition.graph)), [definition.outputNode, definition.imageNode, ...sourceGroups(definition).flatMap(group => group.nodes)]);
  if (!graph[definition.imageNode] || !graph[definition.outputNode]) {
    throw new Error(`The workflow "${definition.name}" is missing its image input or output node: set it up again on the My workflows page`);
  }
  const loader = graph[definition.imageNode];
  graph[definition.imageNode] = { inputs: { image: targetImage }, class_type: 'ETN_LoadImageBase64', _meta: { title: loader._meta?.title || 'Input Image' } };
  for (const setting of definition.settings || []) {
    const node = graph[setting.node];
    if (!node) continue;
    node.inputs[setting.input] = setting.seed && values?.[randomSeedKey(setting)] === true
      ? randomSeed(setting)
      : settingValue(setting, values?.[`${setting.node}.${setting.input}`], node.inputs[setting.input]);
  }
  // A seed of -1 is efficiency-nodes' "a new random seed each run": its frontend script picks one when the prompt
  // is queued, so ComfyUI itself would refuse -1
  for (const node of Object.values(graph)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (value === -1 && SEED_NAME.test(name)) node.inputs[name] = randomSeed({});
    }
  }
  for (const group of sourceGroups(definition)) {
    for (const node of group.nodes) {
      addSourceImages(graph, { node, label: group.label, batch: group.batch }, sourceImages[node], nsfw, definition.name);
    }
  }
  const result = graph[definition.outputNode].inputs[definition.outputInput];
  if (!isLink(result)) {
    throw new Error(`The workflow "${definition.name}" has no image going into its output node`);
  }
  graph[definition.outputNode] = { inputs: { images: result }, class_type: 'PreviewImage', _meta: { title: 'Final Result', img2img_result: true } };
  if (nsfw.enabled) {
    sharedWorkflows().addSafetyGate(graph, definition.imageNode, CUSTOM_WORKFLOW_INPUT_GATE, nsfw);
    const checked = sharedWorkflows().addSafetyCheck(graph, graph[definition.outputNode].inputs.images, CUSTOM_WORKFLOW_RESULT_GATE, nsfw, 'result');
    graph[definition.outputNode].inputs.images = checked;
  }
  return graph;
}

// Only the nodes in `roots` and what they read from: every other output node (SaveImage, previews...) is left out,
// so ComfyUI doesn't run it. An output node that also passes its image on (KSampler (Efficient)) stays when the
// result needs it.
function neededNodes(graph, roots) {
  const needed = new Set();
  const visit = id => {
    if (needed.has(id) || !graph[id]) return;
    needed.add(id);
    for (const value of Object.values(graph[id].inputs || {})) {
      if (isLink(value)) visit(String(value[0]));
    }
  };
  roots.forEach(id => visit(String(id)));
  return Object.fromEntries(Object.entries(graph).filter(([id]) => needed.has(id)));
}

// shared/workflows.js's functions: globals in the extension, required under Node
function sharedWorkflows() {
  return typeof addSafetyCheck === 'function' ? { addSafetyGate, addSafetyCheck } : require('./workflows.js');
}

// The source pickers of a definition, in order: [{ key, label, batch, nodes }] (key: the group, for
// customWorkflowValues "source:key"; nodes in the order they get the source's images)
function sourceGroups(definition) {
  const groups = new Map();
  for (const source of definition?.sourceNodes || []) {
    const key = source.group || source.node;
    if (!groups.has(key)) groups.set(key, { key, label: source.label, batch: Boolean(source.batch), nodes: [] });
    groups.get(key).nodes.push(source.node);
  }
  for (const group of groups.values()) {
    if (group.nodes.length > 1) group.batch = false; // each node gets one image
  }
  return [...groups.values()];
}

// Which Load Image nodes (other than the page image's) belong together: the ones that feed the same node, like
// the two inputs of an ImageBatch or any other node that takes several images, whatever it is. Returns groups
// of node ids, each in the order of the inputs they go into; a node feeding nothing shared is a group of its own.
function suggestSourceGroups(graph, objectInfo, imageNode) {
  const loaders = imageInputNodes(graph, objectInfo).filter(id => id !== imageNode);
  const parent = new Map(loaders.map(id => [id, id]));
  const root = id => (parent.get(id) === id ? id : root(parent.get(id)));
  const order = new Map(); // loader -> [consumer's position in the graph, input position] of its first use
  Object.entries(graph).forEach(([, node], nodeIndex) => {
    const fed = Object.values(node.inputs).map((value, inputIndex) => [value, inputIndex])
      .filter(([value]) => isLink(value) && value[1] === 0 && parent.has(value[0]));
    fed.forEach(([[loader], inputIndex]) => {
      if (!order.has(loader)) order.set(loader, [nodeIndex, inputIndex]);
      parent.set(root(loader), root(fed[0][0][0]));
    });
  });
  const groups = new Map();
  for (const id of loaders) {
    if (!groups.has(root(id))) groups.set(root(id), []);
    groups.get(root(id)).push(id);
  }
  const position = id => order.get(id) || [Infinity, Infinity];
  const byPosition = (a, b) => position(a)[0] - position(b)[0] || position(a)[1] - position(b)[1];
  return [...groups.values()].map(group => group.sort(byPosition)).sort((a, b) => byPosition(a[0], b[0]));
}

// The images for each source node, { node: [image, ...] }, from imagesOf(groupKey) (a picked source's images)
function sourceImagesByNode(definition, imagesOf) {
  const byNode = {};
  for (const group of sourceGroups(definition)) {
    const images = imagesOf(group.key) || [];
    if (group.nodes.length === 1) {
      byNode[group.nodes[0]] = images;
    } else {
      group.nodes.forEach((node, index) => {
        const image = images[Math.min(index, images.length - 1)];
        byNode[node] = image ? [image] : [];
      });
    }
  }
  return byNode;
}

// A source node's images: its loader gets the first one; with batch on, the others get loaders of their own and
// ImageBatch nodes join them all. Each image passes the NSFW gate before anything uses it.
function addSourceImages(graph, source, images, nsfw, workflowName) {
  const node = graph[source.node];
  if (!node) return;
  if (!images?.length) {
    throw new Error(`Pick a source for "${source.label}" in the popup (workflow "${workflowName}")`);
  }
  const used = source.batch ? images : images.slice(0, 1);
  const title = node._meta?.title || 'Source';
  const outputs = used.map((image, index) => {
    const loader = index === 0 ? source.node : `${source.node}:image${index}`;
    graph[loader] = { inputs: { image }, class_type: 'ETN_LoadImageBase64', _meta: { title: index === 0 ? title : `${title} (${index + 1})` } };
    if (!nsfw.enabled) return [loader, 0];
    return sharedWorkflows().addSafetyCheck(graph, [loader, 0], `${CUSTOM_WORKFLOW_SOURCE_GATE}:${source.node}:${index}`, nsfw, 'source image');
  });
  let joined = outputs[0];
  for (let index = 1; index < outputs.length; index++) {
    const batch = `${source.node}:batch${index}`;
    graph[batch] = { inputs: { image1: joined, image2: outputs[index] }, class_type: 'ImageBatch', _meta: { title: `${title} batch` } };
    joined = [batch, 0];
  }
  // Everything that read the loader's image reads the gated (and joined) images instead; its mask stays
  const own = new Set([source.node, ...Object.keys(graph).filter(id => id.startsWith(`${source.node}:`) || id.startsWith(`${CUSTOM_WORKFLOW_SOURCE_GATE}:${source.node}:`))]);
  for (const [id, other] of Object.entries(graph)) {
    if (own.has(id)) continue;
    for (const [name, value] of Object.entries(other.inputs)) {
      if (isLink(value) && value[0] === source.node && value[1] === 0) other.inputs[name] = joined;
    }
  }
}

// What changes a custom workflow's result, for the extension's cache key. (With a random seed, an image already
// processed with these settings shows its cached result again; another image gets a new seed.)
function customWorkflowCacheKey(definition, values, defaultSourceId = null) {
  const own = {};
  for (const group of sourceGroups(definition)) {
    own[`source:${group.key}`] = { id: values?.[`source:${group.key}`] || defaultSourceId, batch: group.batch, nodes: group.nodes };
  }
  for (const setting of definition?.settings || []) {
    for (const key of [`${setting.node}.${setting.input}`, ...(setting.seed ? [randomSeedKey(setting)] : [])]) {
      if (values?.[key] !== undefined) own[key] = values[key];
    }
  }
  return { workflow: `${CUSTOM_WORKFLOW_PREFIX}${definition?.id}`, version: definition?.version, values: own };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CUSTOM_WORKFLOW_PREFIX, CUSTOM_WORKFLOW_INPUT_GATE, CUSTOM_WORKFLOW_RESULT_GATE, CUSTOM_WORKFLOW_SOURCE_GATE, isCustomWorkflow,
    customWorkflowId, parseComfyWorkflow, uiWorkflowToApi, workflowLayout, autoLayout, sourceGroups, suggestSourceGroups,
    sourceImagesByNode, imageInputNodes, imageOutputNodes, outputNodeIds, settingCandidates,
    describeSettingInput, settingValue, randomSeedKey, buildCustomWorkflow, customWorkflowCacheKey,
  };
}
