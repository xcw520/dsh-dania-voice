import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanForSpeech, splitSegments } from '../index.js'

test('行内代码转成能念的英文，不是删掉', () => {
  const out = cleanForSpeech('`ops_bash` 的后台任务修好了')
  assert.match(out, /ops bash/)
  assert.match(out, /的后台任务修好了/)
})

test('下划线换成空格', () => {
  assert.equal(cleanForSpeech('`run_in_background`'), 'run in background')
})

test('多个行内代码都保留', () => {
  const out = cleanForSpeech('`ops_bash` 和 `EXECUTOR_UNAVAILABLE` 都不删')
  assert.match(out, /ops bash/)
  assert.match(out, /executor unavailable/)
})

test('代码块给一句交代，不是静默跳过', () => {
  const out = cleanForSpeech('前一句。\n\n```js\nconst a = 1\n```\n\n后一句。')
  assert.match(out, /这里有一段代码/)
  assert.match(out, /前一句/)
  assert.match(out, /后一句/)
})

test('波浪线代码块同样处理', () => {
  const out = cleanForSpeech('前。\n~~~\ncode\n~~~\n后。')
  assert.match(out, /这里有一段代码/)
})

test('正文里的下划线不再被当 markdown 删', () => {
  assert.equal(cleanForSpeech('run_in_background 是函数名'), 'run_in_background 是函数名')
})

test('文件名里的星号不再被吞', () => {
  const out = cleanForSpeech('留下 .dsh-ops-update-*.lock 锁文件')
  assert.match(out, /dsh-ops-update/)
  assert.match(out, /lock/)
})

test('成对的 markdown 强调标记仍然去掉', () => {
  assert.equal(cleanForSpeech('这里是**重点**内容'), '这里是重点内容')
  assert.equal(cleanForSpeech('这里是*重点*内容'), '这里是重点内容')
  assert.equal(cleanForSpeech('这里是~~删掉~~内容'), '这里是删掉内容')
})

test('中文段落原样保留', () => {
  const src = '面板采集恢复时不再重复封顶，PTC 批量审计也不再返回不存在的引用。'
  assert.equal(cleanForSpeech(src), src)
})

test('空输入返回空串', () => {
  assert.equal(cleanForSpeech(''), '')
  assert.equal(cleanForSpeech(null), '')
})

test('截图里那段话不再丢字', () => {
  const src = '`ops_bash` 的后台任务修好了，`run_in_background` 不再必然报 `EXECUTOR_UNAVAILABLE`，前台超时也能转成后台。'
  const out = cleanForSpeech(src)
  for (const word of ['ops bash', 'run in background', 'executor unavailable', '的后台任务修好了', '前台超时也能转成后台']) {
    assert.ok(out.includes(word), `缺少「${word}」：${out}`)
  }
})

test('切段后每一段都不超过上限', () => {
  const long = '这是一句话。'.repeat(60)
  const segs = splitSegments(cleanForSpeech(long), 120)
  assert.ok(segs.length > 1)
  for (const s of segs) assert.ok(s.length <= 120, `超长段：${s.length}`)
})

test('全大写长词转小写，短缩写保留', () => {
  assert.equal(cleanForSpeech('`EXECUTOR_UNAVAILABLE`'), 'executor unavailable')
  assert.equal(cleanForSpeech('`PTC`'), 'PTC')
  assert.equal(cleanForSpeech('`HTTP`'), 'HTTP')
})

test('行内代码里整段是网址时丢掉，不留反引号', () => {
  const out = cleanForSpeech('看 `https://github.com/RVC-Boss/GPT-SoVITS` 这个仓库')
  assert.ok(!out.includes('http'), `还留着网址：${out}`)
  assert.ok(!out.includes('`'), `还留着反引号：${out}`)
  assert.match(out, /看\s+这个仓库/)
})

test('裸网址同样丢掉', () => {
  const out = cleanForSpeech('打开 https://example.com/a?b=1 看看')
  assert.ok(!out.includes('example'), `还留着网址：${out}`)
  assert.match(out, /打开\s+看看/)
})

test('www 开头的网址也丢掉', () => {
  const out = cleanForSpeech('去 www.example.com 查')
  assert.ok(!out.includes('example'))
})

test('列表项之间补句号，不会念成一长串', () => {
  const out = cleanForSpeech('- 行内代码转英文\n- 代码块给一句交代\n- 强调标记只删成对的')
  assert.match(out, /行内代码转英文。/)
  assert.match(out, /代码块给一句交代。/)
  // 原来这三条会被拼成「行内代码转英文代码块给一句交代强调标记只删成对的」
  assert.ok(!out.includes('英文代码'), `还是粘在一起：${out}`)
})

test('标题后面补句号，和正文断开', () => {
  const out = cleanForSpeech('## 还没查清的\n\n正文在这里。')
  assert.match(out, /还没查清的。/)
  assert.match(out, /正文在这里/)
})

test('表格行删干净，不留空行和多余句号', () => {
  const out = cleanForSpeech('注释写错了。\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n另一件事')
  assert.ok(!out.includes('。。'), `有双句号：${out}`)
  assert.equal(out, '注释写错了。\n另一件事')
})

test('默认分段上限是 90 字', () => {
  const long = '这是一句话。'.repeat(60)
  const segs = splitSegments(cleanForSpeech(long))
  for (const s of segs) assert.ok(s.length <= 90, `超长段 ${s.length} 字：${s}`)
})
