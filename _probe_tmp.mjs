function extensionFromFileName(name) {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i) : ''
}
function wildcardToRegExp(pattern) {
  let p = pattern
  if (p.startsWith('*.')) p = p.substring(1)
  const special = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']'])
  let rs = ''
  for (const ch of p) {
    if (ch === '*') rs += '.*'
    else if (ch === '?') rs += '.'
    else if (ch === '/' || ch === '\\') rs += '[\\\\/]'
    else if (special.has(ch)) rs += '\\' + ch
    else rs += ch
  }
  if (p.startsWith('.')) return new RegExp(rs + '$', 'i')
  return new RegExp('^' + rs + '$', 'i')
}
function shouldExclude(filePath, fileName, rules) {
  const active = rules.filter(r => r.isActive)
  if (!active.length) return false
  const lowerName = fileName.toLowerCase()
  const ext = extensionFromFileName(fileName).toLowerCase()
  const normalizedPath = filePath.replace(/\\/g, '/')
  for (const rule of active) {
    const v = (rule.value || '').trim()
    if (!v) continue
    const lv = v.toLowerCase()
    switch (rule.type) {
      case 'file':
        if (lowerName === lv) return true
        break
      case 'extension': {
        const re = lv.startsWith('.') ? lv : '.' + lv
        if (ext === re) return true
        break
      }
      case 'wildcard': {
        const rx = wildcardToRegExp(v)
        if (/[\\/]/.test(v)) {
          if (rx.test(normalizedPath)) return true
        } else {
          if (rx.test(fileName)) return true
        }
        break
      }
    }
  }
  return false
}
const rule = {
  id: 'test-tmp-rule',
  type: 'wildcard',
  value: '*.tmp',
  isSystem: false,
  isActive: true
}
console.log('regex for *.tmp:', wildcardToRegExp('*.tmp').source)
console.log('b.tmp:', shouldExclude('C:/root/dir/b.tmp', 'b.tmp', [rule]))
console.log('a.txt:', shouldExclude('C:/root/dir/a.txt', 'a.txt', [rule]))
