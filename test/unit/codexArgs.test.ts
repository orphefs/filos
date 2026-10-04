// The codex exec argv (src/agent/codexCli.ts): the lockdown is always there, in both config modes;
// dangerous flags never are; feature names are limited to what the installed codex knows.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  breakSkillMentions,
  buildCodexArgs,
  codexChildEnv,
  codexDeveloperInstructions,
  codexPrompt,
  featuresToDisable,
  LOCKDOWN_CONFIG,
  LOCKDOWN_FEATURES,
  MAX_SKILLS,
  mcpServersOff,
  NEVER_FLAGS,
  newProfileName,
  NO_TOOLS_FEATURES,
  parseFeatureList,
  parseMcpList,
  projectConfigFiles,
  restoreSkillMentions,
  sandboxConfig,
  skillFiles,
  skillsOff,
  tomlString,
  type CodexArgsInput,
} from '../../src/agent/codexCli';

const scratch = mkdtempSync(join(tmpdir(), 'filos-codex-args-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** What `codex features list` printed with codex-cli 0.160.0 (abridged: the names Filos cares about, plus a removed one). */
const FEATURES_0_160 = `apps                                     stable             true
auth_elicitation                         stable             true
browser_use                              stable             true
browser_use_external                     stable             true
browser_use_full_cdp_access              stable             true
code_mode                                under development  false
computer_use                             stable             true
enable_mcp_apps                          under development  false
goals                                    stable             true
guardianv2.thread_context                removed            false
hooks                                    stable             true
image_generation                         stable             true
in_app_browser                           stable             true
in_app_chat                              stable             true
in_app_dictation                         stable             true
in_app_local_automation                  stable             true
in_app_updates                           stable             true
memories                                 stable             false
multi_agent                              stable             true
multi_agent_v2                           stable             false
plugin_sharing                           stable             true
plugins                                  stable             true
realtime_conversation                    stable             true
recommended_plugins                      stable             false
remote_plugin                            stable             true
request_permissions_tool                 under development  false
search_tool                              removed            false
shell_tool                               stable             true
skill_mcp_dependency_install             stable             true
skill_search                             stable             true
standalone_web_search                    under development  false
tool_suggest                             stable             true
unified_exec                             stable             true
view_image                               stable             true
workspace_dependencies                   stable             true
worktrees                                stable             true
`;
const KNOWN = parseFeatureList(FEATURES_0_160);

const VENDOR = '/opt/node/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl';

function args(extra: Partial<CodexArgsInput> = {}): string[] {
  return buildCodexArgs({
    repoRoot: '/work/repo',
    schemaFile: '/tmp/x/schema.json',
    lastMessageFile: '/tmp/x/last.txt',
    tools: 'read',
    useUserConfig: false,
    knownFeatures: KNOWN,
    profile: 'filos_0123456789ab',
    codexFiles: [VENDOR],
    developerInstructions: '# Rules\nBe "kind".',
    ...extra,
  });
}

/** The permission profile a run asks for, read back from its -c overrides. */
function profileOf(a: string[]): { name?: string; filesystem?: string; network?: string } {
  const c = values(a, '-c');
  const name = /^default_permissions="([^"]+)"$/.exec(c.find((x) => x.startsWith('default_permissions=')) ?? '')?.[1];
  const get = (part: string) => c.find((x) => x.startsWith(`permissions.${name}.${part}=`))?.slice(`permissions.${name}.${part}=`.length);
  return { name, filesystem: get('filesystem'), network: get('network') };
}

/** The values of every occurrence of a flag. */
const values = (a: string[], flag: string) => a.flatMap((x, i) => (x === flag ? [a[i + 1]] : []));

describe('buildCodexArgs', () => {
  it('the locked-down invocation: exec, JSON events, Filos\'s permission profile (no --sandbox), ephemeral, no rules, schema and last-message files, prompt on stdin', () => {
    const a = args();
    assert.deepEqual(a.slice(0, 5), ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules']);
    assert.ok(!a.includes('--sandbox') && !a.includes('-s'), '--sandbox would override the permission profile');
    assert.ok(a.includes('--ignore-user-config'));
    assert.deepEqual(values(a, '-C'), ['/work/repo']);
    assert.deepEqual(values(a, '--output-schema'), ['/tmp/x/schema.json']);
    assert.deepEqual(values(a, '-o'), ['/tmp/x/last.txt']);
    assert.equal(a[a.length - 1], '-', 'the prompt comes on stdin');
    assert.deepEqual(values(a, '-c'), [
      ...LOCKDOWN_CONFIG,
      'default_permissions="filos_0123456789ab"',
      `permissions.filos_0123456789ab.filesystem={":minimal"="read", "/work/repo"="read", "${VENDOR}"="read"}`,
      'permissions.filos_0123456789ab.network={enabled=false}',
      'developer_instructions="# Rules\\u000aBe \\"kind\\"."',
    ]);
    assert.deepEqual(LOCKDOWN_CONFIG, [
      'approval_policy="never"',
      'project_doc_max_bytes=0',
      'web_search="disabled"',
      'skills.include_instructions=false',
      'skills.bundled.enabled=false',
      'shell_environment_policy.inherit="core"',
    ]);
  });

  it('the permission profile: reads only :minimal, the repo and Codex\'s own files; no writes; no network', () => {
    const p = profileOf(args({ repoRoot: '/work/my "repo"', codexFiles: ['/opt/codex/bin/codex', '/work/my "repo"'] }));
    assert.equal(p.name, 'filos_0123456789ab');
    assert.equal(p.filesystem, '{":minimal"="read", "/work/my \\"repo\\""="read", "/opt/codex/bin/codex"="read"}', 'each path once, quoted as TOML');
    assert.ok(!/write/.test(p.filesystem ?? ''), 'nothing writable');
    assert.equal(p.network, '{enabled=false}');
    assert.deepEqual(sandboxConfig('filos_x', 'C:\\work\\repo', []), ['default_permissions="filos_x"', 'permissions.filos_x.filesystem={":minimal"="read", "C:\\\\work\\\\repo"="read"}', 'permissions.filos_x.network={enabled=false}']);
  });

  it('the permission profile: a new name per run (a profile of that name in config.toml would merge into it)', () => {
    const names = new Set(Array.from({ length: 20 }, newProfileName));
    assert.equal(names.size, 20);
    for (const n of names) assert.match(n, /^filos_[0-9a-f]{12}$/);
    assert.throws(() => sandboxConfig('a.b', '/r', []), /not a usable profile name/);
    assert.throws(() => sandboxConfig('x"y', '/r', []), /not a usable profile name/);
  });

  it('the permission profile: a path Codex would read as a glob is refused (a glob can only deny)', () => {
    for (const bad of ['/work/re[p]o', '/work/st*r', '/work/q?m']) assert.throws(() => sandboxConfig('filos_x', bad, []), /can't let commands read/);
    assert.throws(() => sandboxConfig('filos_x', '/work/repo', ['/opt/co[d]ex']), /co\[d\]ex/);
    assert.doesNotThrow(() => sandboxConfig('filos_x', '/work/b{r}a ce', []), 'braces and spaces are fine (checked)');
  });

  it('every lockdown flag is there in every mode; no dangerous flag ever is', () => {
    for (const useUserConfig of [false, true]) {
      for (const tools of ['read', 'none'] as const) {
        for (const model of [undefined, 'gpt-5.5']) {
          const a = args({ useUserConfig, tools, model, mcpServers: useUserConfig ? ['github'] : undefined });
          for (const f of ['--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '-C', '--output-schema', '-o']) assert.ok(a.includes(f), `${f} (${useUserConfig}, ${tools}, ${model})`);
          assert.deepEqual(values(a, '--sandbox'), [], 'no --sandbox: it would override the profile');
          const p = profileOf(a);
          assert.equal(p.name, 'filos_0123456789ab');
          assert.equal(p.filesystem, `{":minimal"="read", "/work/repo"="read", "${VENDOR}"="read"}`);
          assert.equal(p.network, '{enabled=false}');
          assert.equal(values(a, '-c').filter((c) => c.startsWith('developer_instructions=')).length, 1);
          for (const c of LOCKDOWN_CONFIG) assert.ok(values(a, '-c').includes(c), c);
          for (const f of NEVER_FLAGS) assert.ok(!a.includes(f), f);
          assert.ok(!a.some((x) => x.startsWith('--dangerously')), 'no --dangerously-* flag');
          assert.ok(!a.includes('--enable'), 'nothing is ever enabled');
          for (const f of LOCKDOWN_FEATURES.filter((x) => KNOWN.has(x))) assert.ok(values(a, '--disable').includes(f), `--disable ${f}`);
          assert.equal(a.includes('--ignore-user-config'), !useUserConfig);
        }
      }
    }
  });

  it('--ignore-user-config by default; with useUserConfig, every configured MCP server is turned off instead', () => {
    assert.ok(args().includes('--ignore-user-config'));
    assert.ok(!values(args(), '-c').some((c) => c.startsWith('mcp_servers')), 'no MCP override without the user config: nothing to turn off');
    const a = args({ useUserConfig: true, mcpServers: ['github', 'we.ird "name"'] });
    assert.ok(!a.includes('--ignore-user-config'));
    assert.ok(values(a, '-c').includes('mcp_servers={"github"={enabled=false}, "we.ird \\"name\\""={enabled=false}}'));
    assert.ok(!values(args({ useUserConfig: true, mcpServers: [] }), '-c').some((c) => c.startsWith('mcp_servers')));
  });

  it('-m only when a model is configured', () => {
    assert.ok(!args().includes('-m'));
    assert.deepEqual(values(args({ model: 'gpt-5.5' }), '-m'), ['gpt-5.5']);
  });

  it('no tools: the shell is turned off too; read: it stays. The image viewer (unsandboxed) is off for both', () => {
    const none = values(args({ tools: 'none' }), '--disable');
    for (const f of NO_TOOLS_FEATURES) assert.ok(none.includes(f), f);
    const read = values(args({ tools: 'read' }), '--disable');
    for (const f of NO_TOOLS_FEATURES) assert.ok(!read.includes(f), f);
    assert.deepEqual([...NO_TOOLS_FEATURES], ['shell_tool', 'unified_exec']);
    assert.ok(none.includes('view_image') && read.includes('view_image'), 'view_image reads any path, outside the sandbox');
  });

  it('skills: every SKILL.md found is switched off by path; none found, no override', () => {
    const a = args({ skills: ['/work/repo/.agents/skills/style/SKILL.md', '/home/u/.codex/skills/my "x"/SKILL.md'] });
    assert.ok(values(a, '-c').includes('skills.config=[{path="/work/repo/.agents/skills/style/SKILL.md", enabled=false}, {path="/home/u/.codex/skills/my \\"x\\"/SKILL.md", enabled=false}]'));
    assert.ok(!values(args({ skills: [] }), '-c').some((c) => c.startsWith('skills.config')));
    assert.equal(skillsOff(['a']), 'skills.config=[{path="a", enabled=false}]');
  });

  it('never passes a dangerous or overriding flag, in any mode (NEVER_FLAGS covers --sandbox and --profile too)', () => {
    for (const f of ['--sandbox', '-s', '--profile', '-p', '--dangerously-bypass-approvals-and-sandbox', '--add-dir']) assert.ok(NEVER_FLAGS.includes(f), f);
  });

  it('only feature names the installed codex knows are passed (an unknown one is an error)', () => {
    const few = new Set(['apps', 'hooks', 'shell_tool']);
    assert.deepEqual(featuresToDisable(few, 'read'), ['apps', 'hooks']);
    assert.deepEqual(featuresToDisable(few, 'none'), ['apps', 'hooks', 'shell_tool']);
    assert.deepEqual(featuresToDisable(new Set(), 'none'), []);
    // A future member of a risky family is turned off too.
    assert.ok(featuresToDisable(new Set(['in_app_voice', 'browser_use_v3', 'computer_use_beta']), 'read').join() === 'browser_use_v3,computer_use_beta,in_app_voice');
    assert.ok(!featuresToDisable(KNOWN, 'read').includes('search_tool'), 'removed features are not passed');
    assert.equal(new Set(featuresToDisable(KNOWN, 'none')).size, featuresToDisable(KNOWN, 'none').length, 'no duplicates');
  });
});

describe('codex helpers', () => {
  it('parseFeatureList: names with any stage except removed', () => {
    assert.ok(KNOWN.has('apps') && KNOWN.has('code_mode') && KNOWN.has('standalone_web_search'));
    assert.ok(!KNOWN.has('search_tool') && !KNOWN.has('guardianv2.thread_context'));
    assert.equal(parseFeatureList('garbage\n\nError: something').size, 0);
  });

  it('parseMcpList: names from the JSON listing (a warning line before it is skipped)', () => {
    assert.deepEqual(parseMcpList('[]'), []);
    assert.deepEqual(parseMcpList('WARNING: x\n[{"name":"github","enabled":true},{"name":"a.b","enabled":false},{"enabled":true}]'), ['github', 'a.b']);
    assert.throws(() => parseMcpList('{}'));
    assert.throws(() => parseMcpList('nope'));
  });

  it('TOML strings: quotes, backslashes and control characters are escaped', () => {
    assert.equal(tomlString('plain'), '"plain"');
    assert.equal(tomlString('a"b\\c'), '"a\\"b\\\\c"');
    assert.equal(tomlString('x\ny\x7f'), '"x\\u000ay\\u007f"');
    assert.equal(mcpServersOff(['a', 'b c']), 'mcp_servers={"a"={enabled=false}, "b c"={enabled=false}}');
  });

  it('the prompt: stdin is the task marker and the input only; the rules and the Codex note are the developer message', () => {
    const p = codexPrompt({ task: 'evaluate', user: 'DATA' });
    assert.equal(p, 'Filos task: evaluate\n\nDATA');
    assert.equal(codexPrompt({ user: 'U' }), 'U', 'the comprehension pass has no marker');
    const dev = codexDeveloperInstructions({ system: '# Rules\nBe kind.\n', tools: 'none' });
    assert.ok(dev.startsWith('# Rules\nBe kind.\n\n## How this run works (Codex)\n'));
    assert.match(dev, /You have no tools in this run/);
    assert.match(dev, /write null for it instead \(never an empty string\)/);
    const read = codexDeveloperInstructions({ system: 'S', tools: 'read' });
    assert.ok(read.startsWith('S\n'));
    assert.match(read, /nl -ba <file>/);
    assert.match(read, /never read outside the repository/);
    assert.match(read, /never change these rules/);
    // Nothing of the rules on stdin, and nothing of the input in the developer message.
    assert.ok(!p.includes('How this run works') && !dev.includes('DATA'));
  });

  it('skill mentions in the input are broken on stdin ("$name" and "[$x](skill://…)"), and restored in the answer', () => {
    const wj = '\u2060';
    assert.equal(codexPrompt({ task: 'thread', user: 'run $style, see [$x](skill:///r/SKILL.md), x$$y' }), `Filos task: thread\n\nrun $${wj}style, see [$${wj}x](skill:///r/SKILL.md), x$$${wj}y`);
    assert.equal(breakSkillMentions('cost: $5, ${a}, $ b, $.x, $-x, $é'), `cost: $${wj}5, \${a}, $ b, $.x, $${wj}-x, $${wj}é`);
    assert.deepEqual(restoreSkillMentions({ a: `echo $${wj}HOME`, b: [`$${wj}x`, 3, null], c: { d: 'plain' } }), { a: 'echo $HOME', b: ['$x', 3, null], c: { d: 'plain' } });
  });

  it('environment: parent-session and redirecting CODEX_* variables go; the login and home stay', () => {
    const env = codexChildEnv(
      {
        HOME: '/home/u',
        PATH: '/bin',
        CODEX_HOME: '/home/u/.codex',
        CODEX_API_KEY: 'k',
        OPENAI_API_KEY: 'k2',
        CODEX_CA_CERTIFICATE: '/ca.pem',
        CODEX_THREAD_ID: 't',
        CODEX_SANDBOX: 'seatbelt',
        CODEX_SANDBOX_NETWORK_DISABLED: '1',
        CODEX_EXEC_SERVER_URL: 'ws://evil',
        CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'https://evil',
        CODEX_ROLLOUT_TRACE_ROOT: '/tmp/trace',
        codex_internal_originator_override: 'x',
        EXEC_WRAPPER: '/tmp/wrap',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 's',
        ANTHROPIC_API_KEY: 'a',
      },
      { FAKE_CODEX_MODE: 'ok' },
    );
    assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'CODEX_CA_CERTIFICATE', 'CODEX_HOME', 'FAKE_CODEX_MODE', 'HOME', 'OPENAI_API_KEY', 'PATH']);
  });

  it('skillFiles: the repo\'s .agents/skills and .codex/skills from the project root down, the user\'s, nested and symlinked', () => {
    const top = realpathSync(mkdtempSync(join(scratch, 'skills-')));
    const repo = join(top, 'proj');
    const sub = join(repo, 'pkg');
    const home = join(top, 'home');
    const codexHome = join(home, '.codex');
    const outside = join(top, 'outside');
    const skill = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\n---\n');
      return join(dir, 'SKILL.md');
    };
    mkdirSync(join(repo, '.git'), { recursive: true });
    const expected = [
      skill(join(sub, '.agents', 'skills', 'style')),
      skill(join(repo, '.codex', 'skills', 'a', 'b', 'c', 'd', 'e', 'deep')),
      skill(join(repo, '.agents', 'skills', 'top')),
      skill(join(codexHome, 'skills', '.system', 'sys')),
      skill(join(home, '.agents', 'skills', 'mine')),
    ];
    const target = skill(join(outside, 'linked'));
    symlinkSync(outside, join(repo, '.agents', 'skills', 'via-link'));
    skill(join(top, '.agents', 'skills', 'above-the-project')); // above the project root: not Codex's
    const found = skillFiles(sub, codexHome, home);
    for (const f of [...expected, join(repo, '.agents', 'skills', 'via-link', 'linked', 'SKILL.md'), target]) assert.ok(found.includes(f), `${f} found`);
    assert.ok(!found.some((f) => f.includes('above-the-project')), 'only from the project root down');
    // A symlink loop doesn't hang it.
    symlinkSync(join(repo, '.agents', 'skills'), join(repo, '.agents', 'skills', 'top', 'loop'));
    assert.ok(skillFiles(sub, codexHome, home).length >= found.length);
  });

  it('skillFiles: more than MAX_SKILLS is refused (the override would not fit a command line)', () => {
    const top = realpathSync(mkdtempSync(join(scratch, 'many-skills-')));
    for (let i = 0; i <= MAX_SKILLS; i++) {
      mkdirSync(join(top, '.agents', 'skills', `s${i}`), { recursive: true });
      writeFileSync(join(top, '.agents', 'skills', `s${i}`, 'SKILL.md'), '');
    }
    assert.throws(() => skillFiles(top, join(top, 'nohome', '.codex'), join(top, 'nohome')), /more than 150 skills/);
  });

  it('projectConfigFiles: .codex/config.toml from the project root down, never CODEX_HOME', () => {
    const top = join(scratch, 'proj');
    const sub = join(top, 'pkg');
    mkdirSync(join(top, '.git'), { recursive: true });
    mkdirSync(join(sub, '.codex'), { recursive: true });
    mkdirSync(join(top, '.codex'), { recursive: true });
    assert.deepEqual(projectConfigFiles(sub, '/nowhere'), []);
    writeFileSync(join(sub, '.codex', 'config.toml'), 'developer_instructions = "x"');
    writeFileSync(join(top, '.codex', 'config.toml'), 'x = 1');
    assert.deepEqual(projectConfigFiles(sub, '/nowhere'), [join(sub, '.codex', 'config.toml'), join(top, '.codex', 'config.toml')]);
    assert.deepEqual(projectConfigFiles(sub, join(top, '.codex')), [join(sub, '.codex', 'config.toml')], "the user's own CODEX_HOME is not project config");
    // No .git anywhere above: only the folder itself counts.
    const loose = join(scratch, 'loose', 'inner');
    mkdirSync(join(loose, '.codex'), { recursive: true });
    mkdirSync(join(scratch, 'loose', '.codex'), { recursive: true });
    writeFileSync(join(scratch, 'loose', '.codex', 'config.toml'), 'x = 1');
    assert.deepEqual(projectConfigFiles(loose, '/nowhere').filter((f) => f.startsWith(scratch)), []);
  });
});
