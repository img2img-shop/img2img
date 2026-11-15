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
//                                         // in this order. min and max are the range the popup's slider offers:
//                                         // the node's own limits unless the workflows page narrowed them.
//     layout }                            // how ComfyUI showed it (workflowLayout), for the workflows page
// A setting can also be a switch for a whole node, { node, label, kind: 'bypass', pass }: switched off in the
// popup, the node is skipped the way ComfyUI skips a bypassed one. pass says which of its inputs takes the place
// of each of its outputs, { outputSlot: inputName } (see bypassPlan). With mute: true in place of pass, the node
// is muted instead, as in ComfyUI: nothing comes out of it, and what read it is left unconnected (see canMute).
// A text input can offer choices written on the My workflows page in place of a text box,
// { node, input, label, kind: 'pick', options: [label, ...], values: [text, ...] }: a dropdown in the popup, or
// with slider: true a slider that steps through them in the order they were written. Each choice is a label the
// popup shows and the text that goes into the input when it's picked; values lines up with options, with '' where
// a label is itself the text, and is left out when every label is. The popup saves the label picked. It also
// offers None ahead of them, saved as '', which leaves the input empty (see PICK_NONE).
// The popup saves the values of those settings in customWorkflowValues[id]["node.input"], for a seed whether
// it's a new random one each time in customWorkflowValues[id]["node.input:random"], for a node's switch whether
// it's off in customWorkflowValues[id]["bypass:node"], and the source picked for a source picker in
// customWorkflowValues[id]["source:group"] (unset: the source selected in the popup's grid).

const CUSTOM_WORKFLOW_PREFIX = 'custom:';
const BYPASS_KEY_PREFIX = 'bypass:';

// The key of a setting's value in customWorkflowValues (and of the setting itself on the My workflows page)
// Used by: web pages, the result tab, the Library, the popup, My workflows, the img2img server.
function settingKey(setting) {
  return setting.kind === 'bypass' ? `${BYPASS_KEY_PREFIX}${setting.node}` : `${setting.node}.${setting.input}`;
}
const CUSTOM_WORKFLOW_INPUT_GATE = 'img2img-input-gate';
const CUSTOM_WORKFLOW_RESULT_GATE = 'img2img-result-gate';
const CUSTOM_WORKFLOW_SOURCE_GATE = 'img2img-source-gate'; // one per source image: `${this}:${node}:${index}`

// Used by: web pages, the result tab, the Library, the popup, the background script, the img2img server.
function isCustomWorkflow(workflow) {
  return typeof workflow === 'string' && workflow.startsWith(CUSTOM_WORKFLOW_PREFIX);
}

// Used by: web pages, the result tab, the Library, the popup, the background script, the img2img server.
function customWorkflowId(workflow) {
  return isCustomWorkflow(workflow) ? workflow.slice(CUSTOM_WORKFLOW_PREFIX.length) : null;
}

// Used by: web pages, the result tab, the Library, My workflows.
const isLink = value => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]);
// Used by: My workflows.
const inputSpecs = info => ({ ...info?.input?.required, ...info?.input?.optional });
// A dynamic combo option's own inputs (its inputs are under "inputs", a node's under "input")
// Used by: My workflows.
const optionSpecs = option => ({ ...option?.inputs?.required, ...option?.inputs?.optional });

// Input types the ComfyUI frontend shows as widgets (they have a value in widgets_values); everything else is a
// socket. A list type is a combo.
const WIDGET_TYPES = ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO', 'COMFY_DYNAMICCOMBO_V3'];
// Used by: My workflows.
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
// Used by: My workflows.
function typesConnect(a, b) {
  if (!a || a === '*' || !b || b === '*' || a === b) return true;
  const [left, right] = [a, b].map(type => String(type).toLowerCase().split(','));
  return left.some(type => right.includes(type));
}

// The input a bypassed node passes on in place of output `slot` (carrying `type`), the way ComfyUI's frontend picks
// it: the input in the same slot when its type fits, else the first of exactly that type, else the first that fits.
// -1 when none does. (Not "the first of the type": a bypassed ControlNet apply would pass positive on as negative.)
// Used by: My workflows.
function bypassedInput(node, slot, type) {
  const inputs = node.inputs || [];
  if (!type || type === '*') return inputs.length > slot ? slot : 0;
  const fits = input => typesConnect(input.type, node.outputs?.[slot]?.type) && typesConnect(input.type, type);
  if (inputs[slot] && fits(inputs[slot])) return slot;
  const exact = inputs.findIndex(input => input.type === type);
  return exact >= 0 ? exact : inputs.findIndex(fits);
}

// The outputs of a node that other nodes read, as a Map of output slot -> whether every input reading it is one
// its node can do without (an optional input)
// Used by: My workflows.
function readOutputs(graph, objectInfo, nodeId) {
  const slots = new Map();
  for (const other of Object.values(graph)) {
    const optional = objectInfo?.[other.class_type]?.input?.optional || {};
    for (const [name, value] of Object.entries(other.inputs || {})) {
      if (isLink(value) && value[0] === String(nodeId)) slots.set(value[1], (slots.get(value[1]) ?? true) && name in optional);
    }
  }
  return slots;
}

// Whether the workflow file has a node switched off (muted or bypassed): it stays off unless the popup turns it on
// Used by: web pages, the result tab, the Library, the popup, My workflows, the img2img server.
function fileSwitchedOff(graph, nodeId) {
  return Boolean(graph?.[nodeId]?._meta?.mode);
}

// Whether a node with a switch in the popup is off: turned off there, or off in the file and not turned on there.
// What's saved is whether it's left out (true), or for a node off in the file, false once it's turned on.
// Used by: web pages, the result tab, the Library, the popup, the img2img server.
function nodeSwitchedOff(definition, setting, values) {
  const saved = values?.[settingKey(setting)];
  return saved === true || (saved === undefined && fileSwitchedOff(definition?.graph, setting.node));
}

// Whether a node can be muted, as ComfyUI mutes one: nothing comes out of it, so what read it is left
// unconnected. Any node something reads can be, as in ComfyUI, which is also what says so when the result can't
// be made that way (a node on the way to it needs what's gone); a node nothing reads has nothing to switch.
// Used by: My workflows, the img2img server.
function canMute(graph, nodeId) {
  return Boolean(graph[nodeId]) && readOutputs(graph, null, nodeId).size > 0;
}

// What a node of an API graph passes on when it's switched off: { outputSlot: inputName } for every output another
// node reads, picked as ComfyUI picks it for a bypassed node (bypassedInput), from the node's definition. An output
// whose input, by that pick, has nothing connected (or that has none) has no entry: what reads it is left unconnected, which
// works when those inputs are all optional. Null when the node can't be left out: nothing reads it, such an
// output feeds an input its node needs, or its definition isn't known (ComfyUI not running, or the node not
// installed).
// Used by: My workflows, the img2img server.
function bypassPlan(graph, objectInfo, nodeId) {
  const node = graph[nodeId];
  const info = objectInfo?.[node?.class_type];
  if (!node || !info) return null;
  const slots = readOutputs(graph, objectInfo, nodeId);
  if (!slots.size) return null;
  // The node's slots as the frontend has them: its sockets, then its widgets
  const typeName = type => Array.isArray(type) ? 'COMBO' : type;
  const specs = Object.entries(inputSpecs(info));
  const inputs = [...specs.filter(([, spec]) => !isWidgetSpec(spec)), ...specs.filter(([, spec]) => isWidgetSpec(spec))]
    .map(([name, spec]) => ({ name, type: typeName(spec[0]) }));
  const outputs = (info.output || []).map(type => ({ type: typeName(type) }));
  const connected = input => input && isLink(node.inputs[input.name]);
  const pass = {};
  for (const [slot, optional] of slots) {
    const type = outputs[slot]?.type;
    const input = inputs[bypassedInput({ inputs, outputs }, slot, type)];
    // Nothing connected to stand in for it: fine where only optional inputs read it (they're left unconnected,
    // as ComfyUI leaves them), and otherwise the workflow can't run without the node
    if (connected(input)) pass[slot] = input.name;
    else if (!optional) return null;
  }
  return pass;
}

// Takes a node out of a graph the way a bypass does: whatever read one of its outputs reads what went into the
// input that stands in for it (pass, from bypassPlan), or nothing when no input does
// Used by: web pages, the result tab, the Library, the img2img server.
function bypassNode(graph, nodeId, pass) {
  const node = graph[nodeId];
  if (!node) return;
  for (const other of Object.values(graph)) {
    for (const [name, value] of Object.entries(other.inputs || {})) {
      if (!isLink(value) || value[0] !== String(nodeId)) continue;
      const source = node.inputs[pass?.[value[1]]];
      if (source === undefined) delete other.inputs[name];
      else other.inputs[name] = source;
    }
  }
  delete graph[nodeId];
}

// Read an uploaded workflow file: ComfyUI's API export as it is, or a saved workflow (nodes and links)
// converted with the installed nodes' definitions (ComfyUI's /object_info). Returns { graph, format, warnings },
// and for a saved workflow its layout (workflowLayout).
// Used by: My workflows, the img2img server.
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
// wired through. A node the file has muted or bypassed stays in the graph, wired as if it ran, with how it is off
// in its _meta (mode 'muted' or 'bypassed', and for a bypass what it passes on, as pass: see fileSwitchedOff), so it
// can be set up and switched on in the popup; buildCustomWorkflow takes it out as the file has it otherwise. One that
// isn't installed, or a subgraph, is removed or skipped over here, as the export does.
// Used by: the img2img server.
function uiWorkflowToApi(ui, objectInfo) {
  const warnings = [];
  const subgraphs = new Map((ui.definitions?.subgraphs || []).map(subgraph => [subgraph.id, subgraph]));
  const graph = {};
  // Where each node output really comes from, once reroutes, primitives, bypasses and subgraph boundaries are
  // followed: a link [apiNodeId, slot], or { value } for a primitive's value. Memoised per scope.
  const resolved = new Map();
  // An off node kept in the graph (see above)
  const keptOff = node => (node.mode === MODE_MUTED || node.mode === MODE_BYPASSED)
    && Boolean(objectInfo?.[node.type]) && !subgraphs.has(node.type) && !UI_ONLY_NODES.includes(node.type)
    && node.type !== 'Reroute' && node.type !== 'PrimitiveNode';

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
      if (!node || (node.mode === MODE_MUTED && !keptOff(node))) {
        result = null;
      } else if (node.type === 'Reroute') {
        result = sourceOfInput(scope, nodeId, 0);
      } else if (node.type === 'PrimitiveNode') {
        result = { value: node.widgets_values?.[0] };
      } else if (node.mode === MODE_BYPASSED && !keptOff(node)) {
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
      if (UI_ONLY_NODES.includes(node.type) || ((node.mode === MODE_MUTED || node.mode === MODE_BYPASSED) && !keptOff(node))) continue;
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
      const meta = { title: node.title || info?.display_name || node.type };
      if (node.mode === MODE_MUTED) meta.mode = 'muted';
      if (node.mode === MODE_BYPASSED) {
        // What it passes on, as the export would have wired it: { outputSlot: inputName } (see bypassNode)
        meta.mode = 'bypassed';
        meta.pass = {};
        (node.outputs || []).forEach((output, slot) => {
          const index = bypassedInput(node, slot, output.type);
          const input = node.inputs?.[index];
          if (input && sourceOfInput(scope, node.id, index) !== null) meta.pass[slot] = input.widget?.name ?? input.name;
        });
      }
      graph[`${scope.prefix}${node.id}`] = { inputs, class_type: node.type, _meta: meta };
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
// Used by: My workflows, the img2img server.
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
// Used by: My workflows, the img2img server.
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
// Used by: My workflows, the img2img server.
function imageInputNodes(graph, objectInfo) {
  return Object.entries(graph).filter(([, node]) => !node._meta?.mode).filter(([, node]) => {
    const info = objectInfo?.[node.class_type];
    const loadsImage = /load.*image|image.*load/i.test(node.class_type) && (!info || info.output?.[0] === 'IMAGE');
    return loadsImage && !Object.values(node.inputs).some(isLink);
  }).map(([id]) => id);
}

// Output nodes whose image could be the result, as [{ node, input }]: an output node (SaveImage, PreviewImage...)
// with a connected image input
// Used by: My workflows, the img2img server.
function imageOutputNodes(graph, objectInfo) {
  const outputs = [];
  for (const [id, node] of Object.entries(graph)) {
    if (node._meta?.mode) continue; // (off in the file)
    const info = objectInfo?.[node.class_type];
    const isOutput = info ? info.output_node : /save|preview/i.test(node.class_type);
    if (!isOutput) continue;
    const specs = inputSpecs(info);
    const input = Object.keys(node.inputs).find(name => isLink(node.inputs[name]) && (info ? specs[name]?.[0] === 'IMAGE' : /image/i.test(name)));
    if (input) outputs.push({ node: id, input });
  }
  return outputs;
}

// The output node whose image is the result, when the user hasn't picked one: the end of the longest chain of
// work, which is what the workflow is for (a workflow often saves or previews a step on the way too, and that
// node can come first in the file). Ties go to the last one in the workflow's order.
// Used by: My workflows, the img2img server.
function defaultOutputNode(graph, objectInfo, outputs = imageOutputNodes(graph, objectInfo)) {
  if (!outputs.length) return null;
  const upstreamCount = id => {
    const seen = new Set();
    const visit = node => {
      if (seen.has(node) || !graph[node]) return;
      seen.add(node);
      for (const value of Object.values(graph[node].inputs || {})) {
        if (isLink(value)) visit(String(value[0]));
      }
    };
    visit(String(id));
    return seen.size;
  };
  return outputs.map(output => ({ node: output.node, size: upstreamCount(output.node) }))
    .reduce((best, output) => output.size >= best.size ? output : best).node;
}

// All output nodes (they're left out when the workflow runs, except the chosen one)
// Used by: the img2img server.
function outputNodeIds(graph, objectInfo) {
  return Object.entries(graph).filter(([, node]) => objectInfo?.[node.class_type]?.output_node || /^(SaveImage|PreviewImage)$/.test(node.class_type)).map(([id]) => id);
}

// The inputs that can become popup settings: every value that isn't a link, on nodes that run, except the page
// image loader's and the terminal output nodes' own (file names, prefixes). Each comes with the control it would
// get.
// Used by: My workflows, the img2img server.
function settingCandidates(graph, objectInfo, { imageNode, outputs = [] } = {}) {
  // Every image loader's inputs are left out too: its file is the page image or a source, or stays as it is (a
  // list of the files in ComfyUI's input folder is no use in the popup). An output node that also passes its
  // values on (KSampler (Efficient) previews its image) is a working node like any other, so its inputs stay.
  // Newer ComfyUI gives SaveImage and PreviewImage an image output of their own too, so what counts is whether
  // anything in the workflow reads it, not whether the node has an output at all.
  const read = new Set();
  for (const node of Object.values(graph)) {
    for (const value of Object.values(node.inputs || {})) {
      if (isLink(value)) read.add(String(value[0]));
    }
  }
  const terminal = id => !read.has(String(id));
  const skip = new Set([imageNode, ...outputs.filter(terminal), ...imageInputNodes(graph, objectInfo)]);
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
// Used by: My workflows.
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
// Used by: My workflows, the img2img server.
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
// Used by: web pages, the result tab, the Library, the popup, the img2img server.
function randomSeedKey(setting) {
  return `${setting.node}.${setting.input}:random`;
}

// Used by: web pages, the result tab, the Library.
function randomSeed(setting) {
  const low = Math.max(0, setting.min ?? 0);
  const high = Math.min(setting.max ?? RANDOM_SEED_LIMIT, RANDOM_SEED_LIMIT);
  return low + Math.floor(Math.random() * (high - low + 1));
}

// Whether a run of the workflow picks a new seed: a seed setting set to a new random one each time, or a seed left
// at -1 in the workflow itself with no setting over it (see buildCustomWorkflow). Each run then gives another result,
// so picking an image again runs it again rather than showing the result already cached for these settings.
// Used by: web pages, the result tab, the img2img server.
function usesRandomSeed(definition, values) {
  if (!definition) return false;
  const covered = new Set();
  for (const setting of definition.settings || []) {
    if (!setting.seed || setting.kind === 'bypass') continue;
    if (values?.[randomSeedKey(setting)] === true) return true;
    covered.add(`${setting.node}.${setting.input}`);
  }
  return Object.entries(definition.graph || {}).some(([id, node]) => Object.entries(node?.inputs || {})
    .some(([name, value]) => value === -1 && SEED_NAME.test(name) && !covered.has(`${id}.${name}`)));
}

// A saved value for a setting, checked against its control: numbers outside the setting's range are clamped to
// it, the workflow's own value included (the My workflows page can narrow a number's range, so the value saved
// in the workflow can sit outside it), and unknown choices and wrong types fall back to the workflow's own value
// Used by: web pages, the result tab, the Library, the popup, the img2img server.
function settingValue(setting, saved, fallback) {
  if (setting.kind === 'number') {
    const number = Number(saved === undefined || saved === null ? fallback : saved);
    return Number.isFinite(number) ? clampToSettingRange(setting, number) : fallback;
  }
  if (setting.kind === 'pick') {
    // One of its choices, by label, or None: the saved one, else the one that gives the workflow's own text, else
    // None (the setting's own None when it has one)
    const options = setting.options || [];
    const none = ownNone(setting) ?? PICK_NONE;
    if (options.includes(saved)) return saved;
    if (saved === PICK_NONE) return none;
    return options.find(option => option === fallback) ?? options.find(option => pickValue(setting, option) === fallback) ?? none;
  }
  if (saved === undefined || saved === null) return fallback;
  switch (setting.kind) {
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

// Every dropdown and slider of choices also offers None, ahead of the choices written for it: the input is left
// empty. It's saved as the empty text, which no choice's label can be.
const PICK_NONE = '';

// A choice the setting's own list calls None takes the place of that one: it sits where it was written, and puts
// in the text written for it (nothing, when it has none)
// Used by: web pages, the result tab, the Library, the popup.
function ownNone(setting) {
  return (setting.options || []).find(option => /^none$/i.test(option.trim()));
}

// What a pick setting's dropdown or slider offers, in order: None first unless the setting has its own
// Used by: the popup, the img2img server.
function pickList(setting) {
  return ownNone(setting) === undefined ? [PICK_NONE, ...(setting.options || [])] : [...setting.options];
}

// The text a pick setting's choice puts into the input: the one written for it, else the label itself (nothing
// for None, the setting's own included)
// Used by: web pages, the result tab, the Library, the popup, the img2img server.
function pickValue(setting, option) {
  const value = setting.values?.[(setting.options || []).indexOf(option)];
  if (typeof value === 'string' && value !== '') return value;
  return option === ownNone(setting) ? '' : option;
}

// The choices written for a text setting's dropdown or slider, [{ label, value }], as the setting keeps them,
// { options, values }: in the order written, each label once. A choice with text and no label is labelled by its
// text; values is left out when every label is itself the text.
// Used by: My workflows, the img2img server.
function pickChoices(choices) {
  const byLabel = new Map();
  for (const choice of choices || []) {
    const value = String(choice.value ?? '');
    const label = String(choice.label ?? '').trim() || value.trim();
    if (label && !byLabel.has(label)) byLabel.set(label, value.trim() === '' || value === label ? '' : value);
  }
  const values = [...byLabel.values()];
  return { options: [...byLabel.keys()], ...(values.some(Boolean) ? { values } : {}) };
}

// A number inside a number setting's range, whole when the input takes integers
// Used by: web pages, the result tab, the Library, the popup.
function clampToSettingRange(setting, number) {
  let value = setting.integer ? Math.round(number) : number;
  if (setting.min !== null && setting.min !== undefined) value = Math.max(setting.min, value);
  if (setting.max !== null && setting.max !== undefined) value = Math.min(setting.max, value);
  return value;
}

// The graph to run: the page image in the image loader, the picked sources' images in the source nodes, the
// popup's values applied, only the chosen output (as a PreviewImage, so nothing is written to ComfyUI's output
// folder) and the NSFW gate on the page image, every source image and the result (img2img is SFW-only; a custom
// graph can generate anything, so the result is checked too). sourceImages: { node: [base64, ...] }.
// Used by: web pages, the result tab, the Library, the img2img server.
function buildCustomWorkflow(definition, targetImage, values, nsfw, sourceImages = {}) {
  const whole = JSON.parse(JSON.stringify(definition.graph));
  // Nodes switched off in the popup go first, so what only they needed is left out with them
  const roles = new Set([definition.outputNode, definition.imageNode, ...sourceGroups(definition).flatMap(group => group.nodes)].map(String));
  // Nodes off in the file with no switch in the popup stay off, as the file has them
  const switched = new Set((definition.settings || []).filter(setting => setting.kind === 'bypass').map(setting => String(setting.node)));
  for (const id of Object.keys(whole).filter(id => fileSwitchedOff(whole, id) && !switched.has(id) && !roles.has(id))) {
    bypassNode(whole, id, whole[id]._meta.mode === 'muted' ? {} : whole[id]._meta.pass);
  }
  for (const setting of definition.settings || []) {
    if (setting.kind === 'bypass' && nodeSwitchedOff(definition, setting, values) && !roles.has(String(setting.node))) {
      bypassNode(whole, setting.node, setting.mute ? {} : setting.pass);
    }
  }
  const graph = neededNodes(whole, [...roles]);
  // What's left runs: a node off in the file but switched on goes as an ordinary node, not marked off (the graph
  // run is also the one a result keeps)
  for (const node of Object.values(graph)) {
    if (node._meta?.mode) {
      const { mode: _mode, pass: _pass, ...meta } = node._meta;
      node._meta = meta;
    }
  }
  if (!graph[definition.imageNode] || !graph[definition.outputNode]) {
    throw new Error(`The workflow "${definition.name}" is missing its image input or output node: set it up again on the My workflows page`);
  }
  const loader = graph[definition.imageNode];
  graph[definition.imageNode] = { inputs: { image: targetImage }, class_type: 'ETN_LoadImageBase64', _meta: { title: loader._meta?.title || 'Input Image' } };
  for (const setting of definition.settings || []) {
    const node = graph[setting.node];
    if (!node || setting.kind === 'bypass') continue;
    const value = setting.seed && values?.[randomSeedKey(setting)] === true
      ? randomSeed(setting)
      : settingValue(setting, values?.[`${setting.node}.${setting.input}`], node.inputs[setting.input]);
    node.inputs[setting.input] = setting.kind === 'pick' ? pickValue(setting, value) : value;
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
// Used by: web pages, the result tab, the Library.
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
// Used by: web pages, the result tab, the Library.
function sharedWorkflows() {
  return typeof addSafetyCheck === 'function' ? { addSafetyGate, addSafetyCheck } : require('./workflows.js');
}

// The source pickers of a definition, in order: [{ key, label, batch, nodes }] (key: the group, for
// customWorkflowValues "source:key"; nodes in the order they get the source's images)
// Used by: web pages, the result tab, the Library, the popup, My workflows, the img2img server.
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
// Used by: My workflows, the img2img server.
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

// The first Load Image node, in the workflow's own order, that isn't one of a set feeding the same node: where
// the page image goes when the user hasn't chosen (the sets are usually sources, like the two sides of a batch)
// Used by: My workflows, the img2img server.
function defaultPageImage(graph, objectInfo, imageNodes = imageInputNodes(graph, objectInfo)) {
  const inSets = new Set(suggestSourceGroups(graph, objectInfo, null).filter(group => group.length > 1).flat());
  return imageNodes.find(id => !inSets.has(id)) ?? imageNodes[0];
}

// Which node of another graph each node of a workflow is, as a Map of node ids: the same id where it's still
// there with the same class (ComfyUI keeps ids when a workflow is edited), else the one node of that class not
// matched yet that has the same title, or the only one when the node was the only one of its class before.
// Nodes with no match are left out. For a changed version of the same workflow, and for a different workflow
// being set up like this one.
// Used by: My workflows, the img2img server.
function matchWorkflowNodes(graph, other) {
  const matched = new Map();
  const taken = new Set();
  for (const [id, node] of Object.entries(graph)) {
    if (other[id]?.class_type === node.class_type) {
      matched.set(id, id);
      taken.add(id);
    }
  }
  const ofClass = (nodes, classType) => Object.entries(nodes).filter(([, node]) => node.class_type === classType);
  for (const [id, node] of Object.entries(graph)) {
    if (matched.has(id)) continue;
    const free = ofClass(other, node.class_type).filter(([otherId]) => !taken.has(otherId));
    const titled = node._meta?.title ? free.filter(([, candidate]) => candidate._meta?.title === node._meta.title) : [];
    const match = titled.length === 1 ? titled[0] : free.length === 1 && ofClass(graph, node.class_type).length === 1 ? free[0] : null;
    if (match) {
      matched.set(id, match[0]);
      taken.add(match[0]);
    }
  }
  return matched;
}

// A workflow's setup carried over to another graph: where its page image, sources and result go and which
// inputs are popup settings, each on the node matchWorkflowNodes finds for it. For the workflow's own changed
// file, so a small change in ComfyUI doesn't mean setting it up again, and for a new workflow set up like an
// existing one. What has no node to go to is left out and named in `lost`, in the user's words; a Load Image
// node the graph newly has becomes a source, as in a new workflow. carryValues(values) carries the popup's saved
// values of the workflow the same way, under the keys of the nodes they belong to now.
// Used by: My workflows, the img2img server.
function carryWorkflowSetup(definition, graph, objectInfo) {
  const nodes = matchWorkflowNodes(definition.graph, graph);
  const name = id => {
    const node = definition.graph[id];
    return node ? `"${node._meta?.title || node.class_type}"` : `node ${id}`;
  };
  const lost = [];
  const imageNodes = imageInputNodes(graph, objectInfo);
  const pageNode = nodes.get(definition.imageNode);
  const imageNode = imageNodes.includes(pageNode) ? pageNode : defaultPageImage(graph, objectInfo, imageNodes);
  if (imageNode !== pageNode) lost.push(`The page image went into ${name(definition.imageNode)}, which this workflow doesn't have: check where it goes now.`);
  const resultNode = nodes.get(definition.outputNode);
  const outputNode = imageOutputNodes(graph, objectInfo).some(output => output.node === resultNode) ? resultNode : undefined;
  if (!outputNode) lost.push(`The result came from ${name(definition.outputNode)}, which this workflow doesn't have: check where it comes from now.`);
  // Each source keeps the nodes it still has, under its key unless that node is gone
  const sourceNodes = [];
  const groupKeys = new Map();
  for (const group of sourceGroups(definition)) {
    const kept = group.nodes.map(node => nodes.get(node)).filter(node => imageNodes.includes(node) && node !== imageNode);
    if (!kept.length) {
      lost.push(`The source "${group.label}" went into ${group.nodes.map(name).join(' and ')}, which this workflow doesn't have.`);
      continue;
    }
    if (kept.length < group.nodes.length) lost.push(`The source "${group.label}" went into ${group.nodes.length} nodes; this workflow has ${kept.length} of them.`);
    const key = kept.includes(nodes.get(group.key)) ? nodes.get(group.key) : kept[0];
    groupKeys.set(group.key, key);
    kept.forEach(node => sourceNodes.push({ node, label: group.label, batch: group.batch, group: key }));
  }
  // Load Image nodes that are new here get a source each, joining the picker of the nodes they feed a node with
  const carriedNodes = new Set(nodes.values());
  for (const group of suggestSourceGroups(graph, objectInfo, imageNode)) {
    const fresh = group.filter(node => !carriedNodes.has(node));
    if (!fresh.length) continue;
    const together = group.map(node => sourceNodes.find(source => source.node === node)).find(Boolean);
    const titled = fresh.map(node => graph[node]._meta?.title).find(title => title && !/^load ?image$/i.test(title));
    const label = together?.label || titled || (sourceNodes.length ? `Source ${new Set(sourceNodes.map(source => source.group)).size + 1}` : 'Source');
    fresh.forEach(node => sourceNodes.push({ node, label, batch: false, group: together?.group || fresh[0] }));
  }
  // A setting stays where its node is there and the input still takes a value
  const outputs = [...outputNodeIds(graph, objectInfo), ...sourceNodes.map(source => source.node)];
  const candidates = new Set(settingCandidates(graph, objectInfo, { imageNode, outputs }).map(candidate => `${candidate.node}.${candidate.input}`));
  const settings = [];
  const fixed = new Set([imageNode, ...imageNodes, ...outputs]);
  for (const setting of definition.settings || []) {
    const node = nodes.get(setting.node);
    if (setting.kind === 'bypass') {
      // A node's switch stays where the node is there and can still be left out (as worked out before when this
      // ComfyUI doesn't know the node)
      const known = node !== undefined && objectInfo?.[graph[node].class_type];
      const there = node !== undefined && !fixed.has(node);
      const pass = !there || setting.mute ? null : known ? bypassPlan(graph, objectInfo, node) : setting.pass;
      if (there && setting.mute && canMute(graph, node)) settings.push({ ...setting, node });
      else if (pass) settings.push({ ...setting, node, pass });
      else lost.push(`The switch "${setting.label}" was for ${name(setting.node)}, which this workflow ${node === undefined ? "doesn't have" : "can't run without"}.`);
      continue;
    }
    if (node !== undefined && candidates.has(`${node}.${setting.input}`)) {
      settings.push({ ...setting, node });
    } else {
      lost.push(`The setting "${setting.label}" (${setting.input} of ${name(setting.node)}) has no input to go to in this workflow.`);
    }
  }
  const carryValues = values => {
    const carried = {};
    for (const [key, value] of Object.entries(values || {})) {
      if (key.startsWith('source:')) {
        const group = groupKeys.get(key.slice('source:'.length));
        if (group !== undefined) carried[`source:${group}`] = value;
        continue;
      }
      if (key.startsWith(BYPASS_KEY_PREFIX)) {
        const switched = nodes.get(key.slice(BYPASS_KEY_PREFIX.length));
        if (switched !== undefined) carried[`${BYPASS_KEY_PREFIX}${switched}`] = value;
        continue;
      }
      const dot = key.indexOf('.');
      const node = dot < 0 ? undefined : nodes.get(key.slice(0, dot));
      if (node !== undefined) carried[node + key.slice(dot)] = value;
    }
    return carried;
  };
  return { imageNode, outputNode, sourceNodes, settings, lost, carryValues };
}

// The images for each source node, { node: [image, ...] }, from imagesOf(groupKey) (a picked source's images)
// Used by: web pages, the result tab, the Library, the img2img server.
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
// Used by: web pages, the result tab, the Library.
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
// Used by: the img2img server.
function customWorkflowCacheKey(definition, values, defaultSourceId = null) {
  const own = {};
  for (const group of sourceGroups(definition)) {
    own[`source:${group.key}`] = { id: values?.[`source:${group.key}`] || defaultSourceId, batch: group.batch, nodes: group.nodes };
  }
  for (const setting of definition?.settings || []) {
    if (setting.kind === 'bypass') {
      // Only when it's off: on is how the workflow ran before it had the switch
      if (values?.[settingKey(setting)] === true) own[settingKey(setting)] = true;
      // (and for a node off in the file, when it's turned on)
      if (values?.[settingKey(setting)] === false && fileSwitchedOff(definition.graph, setting.node)) own[settingKey(setting)] = false;
      continue;
    }
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
    sourceImagesByNode, imageInputNodes, imageOutputNodes, defaultOutputNode, outputNodeIds, settingCandidates,
    describeSettingInput, settingValue, randomSeedKey, usesRandomSeed, buildCustomWorkflow, customWorkflowCacheKey, defaultPageImage,
    matchWorkflowNodes, carryWorkflowSetup, BYPASS_KEY_PREFIX, settingKey, bypassPlan, bypassNode, canMute, fileSwitchedOff, nodeSwitchedOff,
    pickChoices, pickValue, pickList, PICK_NONE,
  };
}
