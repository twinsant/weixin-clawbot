import {
  MAX_ARGUMENT_CHARS as CAP,
  MAX_SCALAR_CHARS as SCAP,
  REDACTED,
  redactToolArguments as r,
} from '../weixin-clawbot.mjs'

let failed = 0
const eq = (label, got, want) => {
  if (got === want) return console.log(`ok   ${label}`)
  failed += 1
  console.log(`FAIL ${label}\n  got:  ${got}\n  want: ${want}`)
}
const has = (label, got, sub) => {
  if (got.includes(sub)) return console.log(`ok   ${label}`)
  failed += 1
  console.log(`FAIL ${label}\n  got: ${got}`)
}
const no = (label, got, sub) => {
  if (!got.includes(sub)) return console.log(`ok   ${label}`)
  failed += 1
  console.log(`FAIL ${label}\n  got: ${got}`)
}

eq(
  'passthrough',
  r('{"command":"ls -la","timeout":30,"force":true,"cwd":null}'),
  '{"command":"ls -la","timeout":30,"force":true,"cwd":null}',
)

const keyed = r(JSON.stringify({
  url: 'https://example.test/v1',
  apiKey: 'plain-looking-value',
  headers: { Authorization: 'whatever', Accept: 'application/json' },
  env: [{ password: 'hunter2' }],
}))
no('key apiKey withheld', keyed, 'plain-looking-value')
no('key password withheld', keyed, 'hunter2')
no('key Authorization withheld', keyed, 'whatever')
has('keeps url', keyed, 'https://example.test/v1')
has('keeps accept', keyed, 'application/json')

const shapes = [
  '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----',
  'sk-abcdefghijklmnopqrstuvwx',
  'AKIAIOSFODNN7EXAMPLE',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p',
  'Bearer abcdefghijklmnopqrstuvwxyz012345',
  'a3f5c8e1b2d4a6f8c0e2b4d6a8f0c2e4',
  'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm8=',
]
for (const secret of shapes) {
  const out = r(JSON.stringify({ note: secret }))
  no(`shape withheld: ${secret.slice(0, 14)}`, out, secret)
  has(`shape marked: ${secret.slice(0, 14)}`, out, REDACTED)
}

const envAsn = r(JSON.stringify({ command: 'GITHUB_TOKEN=s3kr3tvalue deploy.sh' }))
has('env name kept', envAsn, 'GITHUB_TOKEN=')
no('env value withheld', envAsn, 's3kr3tvalue')
has('env command kept', envAsn, 'deploy.sh')

eq('home collapsed', r(JSON.stringify({ path: '/Users/alice/notes/todo.md' }), '/Users/alice'), '{"path":"~/notes/todo.md"}')
eq('home absent', r(JSON.stringify({ path: '/Users/alice/notes/todo.md' })), '{"path":"/Users/alice/notes/todo.md"}')

const long = 'word '.repeat(40)
eq('scalar cap', r(JSON.stringify({ text: long })), `{"text":"${long.slice(0, SCAP)}…"}`)

const many = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, 'value']))
const capped = r(JSON.stringify(many))
eq('total cap length', String(capped.length), String(CAP + 1))
eq('total cap tail', capped.slice(-1), '…')

eq('unparseable kept', r('not json at all'), 'not json at all')
eq('unparseable scrubbed', r('trailing sk-abcdefghijklmnopqrstuvwx'), `trailing ${REDACTED}`)

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
