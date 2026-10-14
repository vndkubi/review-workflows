'use strict';
// Maven POMs read as text: a small XML reader (elements, text, line numbers;
// comments, CDATA, declarations skipped) and the parts of the POM model that
// environment discovery needs. Nothing is executed and nothing is
// downloaded: a parent or BOM outside the repository stays unknown.

function decodeXml(s) {
  return String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(\/?)>/g;

// Tree of { name, line, text, children }; throws on malformed nesting.
function parseXml(text) {
  const root = { name: '#document', line: 1, text: '', children: [] };
  const stack = [root];
  let last = 0;
  let line = 1;
  let counted = 0;
  const lineAt = (idx) => {
    for (let i = counted; i < idx; i += 1) if (text.charCodeAt(i) === 10) line += 1;
    counted = idx;
    return line;
  };
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(text))) {
    const top = stack[stack.length - 1];
    top.text += decodeXml(text.slice(last, m.index));
    last = TOKEN.lastIndex;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      const name = m[2].replace(/^.*:/, '');
      if (top.name !== name) throw new Error(`line ${lineAt(m.index)}: </${name}> closes <${top.name}>`);
      stack.pop();
    } else if (m[3]) {
      const node = { name: m[3].replace(/^.*:/, ''), line: lineAt(m.index), text: '', children: [] };
      top.children.push(node);
      if (!m[4]) stack.push(node);
    }
  }
  if (stack.length !== 1) throw new Error(`<${stack[stack.length - 1].name}> is not closed`);
  return root;
}

const kid = (node, name) => (node ? node.children.find((c) => c.name === name) || null : null);
const kids = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
const textOf = (node) => (node ? node.text.trim() : null);
const at = (node, ...names) => names.reduce((n, name) => kid(n, name), node);

function readDependency(d) {
  return {
    groupId: textOf(kid(d, 'groupId')),
    artifactId: textOf(kid(d, 'artifactId')),
    version: textOf(kid(d, 'version')),
    scope: textOf(kid(d, 'scope')),
    type: textOf(kid(d, 'type')),
    classifier: textOf(kid(d, 'classifier')),
    optional: textOf(kid(d, 'optional')) === 'true',
    line: d.line,
  };
}

function readPlugins(build) {
  return kids(kid(build, 'plugins'), 'plugin').map((p) => ({
    groupId: textOf(kid(p, 'groupId')) || 'org.apache.maven.plugins',
    artifactId: textOf(kid(p, 'artifactId')),
    version: textOf(kid(p, 'version')),
    configuration: kid(p, 'configuration'),
    executions: kids(kid(p, 'executions'), 'execution').map((e) => kid(e, 'configuration')).filter(Boolean),
    line: p.line,
  }));
}

// The POM model: coordinates, parent, properties (with lines), modules,
// dependencies, managed dependencies, plugins (build and pluginManagement).
function readPom(text) {
  const project = kid(parseXml(text), 'project');
  if (!project) throw new Error('no <project> element');
  const parent = kid(project, 'parent');
  const properties = {};
  for (const p of (kid(project, 'properties') || { children: [] }).children) properties[p.name] = { value: p.text.trim(), line: p.line };
  const build = kid(project, 'build');
  return {
    groupId: textOf(kid(project, 'groupId')),
    artifactId: textOf(kid(project, 'artifactId')),
    version: textOf(kid(project, 'version')),
    packaging: textOf(kid(project, 'packaging')) || 'jar',
    parent: parent ? { groupId: textOf(kid(parent, 'groupId')), artifactId: textOf(kid(parent, 'artifactId')), version: textOf(kid(parent, 'version')), relativePath: kid(parent, 'relativePath') ? textOf(kid(parent, 'relativePath')) : '../pom.xml', line: parent.line } : null,
    properties,
    modules: kids(kid(project, 'modules'), 'module').map((m) => textOf(m)),
    dependencies: kids(kid(project, 'dependencies'), 'dependency').map(readDependency),
    managed: kids(at(project, 'dependencyManagement', 'dependencies'), 'dependency').map(readDependency),
    plugins: readPlugins(build),
    managedPlugins: readPlugins(kid(build, 'pluginManagement')),
  };
}

module.exports = { parseXml, readPom, kid, kids, textOf, at, decodeXml };
