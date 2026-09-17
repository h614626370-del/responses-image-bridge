const $ = id => document.getElementById(id);
let view = 'monitor';
let page = 1;
let pages = 1;
let accountPage = 1;
let accountPages = 1;
let latest;
let selected;
let refreshing = false;
let loggedIn = false;
const labels = {
  queued: ['排队中', 'wait'], running: ['执行中', 'busy'], completed: ['已完成', 'good'],
  failed: ['失败', 'bad'], incomplete: ['未完成', 'wait'], canceled: ['已取消', 'wait'],
  client_disconnected: ['客户端断开', 'wait'],
};
const phases = { queued: '排队', upstream: '上游处理', upstream_headers: '收到上游响应',
  delivery: '返回客户端', finished: '结束' };
const seconds = ms => ms == null ? '—' : `${(ms / 1000).toFixed(1)} 秒`;
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function notice(message, isError = false) {
  $('notice').textContent = message;
  $('notice').className = `notice${isError ? ' error' : ''}`;
  $('notice').hidden = !message;
}
function iconButton(button, icon, label, iconOnly = false) {
  button.replaceChildren();
  const image = document.createElement('img');
  image.src = `/admin/icons/${icon}.svg`;
  image.width = 15;
  image.height = 15;
  image.alt = '';
  button.append(image);
  if (!iconOnly) button.append(document.createTextNode(label));
  button.title = label;
  button.setAttribute('aria-label', label);
  button.classList.toggle('icon-only', iconOnly);
}
async function api(path, options = {}) {
  const response = await fetch(`/admin/api${path}`, {
    ...options,
    headers: { 'X-Bridge-Admin': '1', 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (response.status === 401) {
    loggedIn = false;
    $('login').hidden = false;
    $('app').hidden = true;
  }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
async function guarded(button, work) {
  button.disabled = true;
  try { await work(); } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
}
function setSession() {
  loggedIn = true;
  $('login').hidden = true;
  $('app').hidden = false;
}
function renderStatus(data) {
  latest = data;
  $('metric-active').textContent = `${data.active} / ${data.queued}`;
  $('metric-total').textContent = data.total.toLocaleString();
  $('metric-rate').textContent = data.successRate == null ? '—' : `${(data.successRate * 100).toFixed(1)}%`;
  $('metric-latency').textContent = seconds(data.medianMs);
  $('service-state').textContent = data.paused ? '接入已暂停' : '服务运行中';
  $('service-state').className = `badge ${data.paused ? 'wait' : 'good'}`;
  iconButton($('pause'), data.paused ? 'play' : 'pause', data.paused ? '恢复接入' : '暂停接入');
  $('refresh-time').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  if (data.persistError) notice('请求记录写入失败，请检查数据目录权限及磁盘空间。', true);
}
function appendCell(tr, primary, secondary) {
  const td = element('td');
  td.append(element('span', primary ?? '—', 'cell-main'));
  if (secondary) td.append(element('small', secondary));
  tr.append(td);
  return td;
}
function showDetail(row) {
  selected = row;
  const fields = {
    '中转请求 ID': row.request_id,
    '上游 request ID': row.upstream_request_id || '未返回',
    '上游 response ID': row.upstream_response_id || '未返回',
    '开始时间': time(row.started_at),
    '请求模型': row.requested_model,
    'Responses 主控配置': row.route === 'images-edits' ? '未使用' : row.control_model,
    '转发路径': row.route === 'images-edits' ? '图生图直连' : 'Responses',
    '图片模型': row.image_model || '—',
    '输入原图': row.source_images == null ? '—' : `${row.source_images} 张`,
    '上游端点': row.upstream_endpoint || '—',
    '上游主机': row.upstream_host || '—',
    '返回模型': row.response_model,
    '状态': labels[row.outcome]?.[0] || row.outcome,
    '错误码': row.error_code || '无',
    '错误详情': row.error_detail || '无',
    '上游 HTTP 状态': row.upstream_http_status,
    '耗时 / 排队': `${seconds(row.elapsed_ms)} / ${seconds(row.queue_ms)}`,
    '图片数': row.images ?? 0,
    '心跳次数': row.heartbeat_count ?? 0,
    '最近活动': time(row.updated_at),
  };
  $('detail-fields').replaceChildren();
  for (const [label, value] of Object.entries(fields)) {
    $('detail-fields').append(element('dt', label), element('dd', value ?? '—'));
  }
  if (Array.isArray(row.timeline) && row.timeline.length) {
    $('detail-fields').append(element('dt', '处理过程'), element('dd', row.timeline.map(item =>
      `${time(item.at)} ${phases[item.phase] || item.phase}`).join('\n'), 'timeline'));
  }
  const hasFormat = row.request_format && typeof row.request_format === 'object';
  $('request-format-title').hidden = !hasFormat;
  $('request-format').hidden = !hasFormat;
  $('request-format').textContent = hasFormat ? JSON.stringify(row.request_format, null, 2) : '';
  $('usage-result').hidden = true;
  $('lookup-usage').disabled = !row.upstream_request_id;
  $('detail').showModal();
}
function renderRequests(data) {
  pages = data.pages;
  $('requests-body').replaceChildren();
  for (const row of data.items) {
    const tr = element('tr');
    const idCell = element('td');
    const idButton = element('button', row.request_id.slice(0, 12), 'record-link');
    idButton.title = `查看请求 ${row.request_id} 的详情`;
    idButton.onclick = () => showDetail(row);
    idCell.append(idButton, element('small', time(row.started_at)));
    tr.append(idCell);
    appendCell(tr, row.route === 'images-edits' ? '图生图直连' : 'Responses',
      row.route === 'images-edits' ? row.image_model : row.control_model);
    const statusCell = element('td');
    const status = labels[row.outcome] || [row.outcome, ''];
    statusCell.append(element('span', status[0], `badge ${status[1]}`));
    if (row.error_code) statusCell.append(element('small', row.error_code));
    tr.append(statusCell);
    appendCell(tr, seconds(row.elapsed_ms), `排队 ${seconds(row.queue_ms)}`);
    appendCell(tr, row.images ?? '—');
    const actions = element('td');
    const detail = element('button', '详情');
    detail.onclick = () => showDetail(row);
    actions.append(detail);
    if (['queued', 'running'].includes(row.outcome)) {
      const cancel = element('button', '取消');
      cancel.onclick = () => guarded(cancel, async () => {
        if (!confirm('取消此请求？已开始的上游生图仍可能产生费用。')) return;
        await api(`/requests/${row.request_id}/cancel`, { method: 'POST', body: '{}' });
        await refresh();
      });
      actions.append(document.createTextNode(' '), cancel);
    }
    tr.append(actions);
    $('requests-body').append(tr);
  }
  if (!data.items.length) {
    const tr = element('tr');
    const td = element('td', '暂无请求记录', 'empty');
    td.colSpan = 6;
    tr.append(td);
    $('requests-body').append(tr);
  }
  $('request-count').textContent = `${data.total} 条记录`;
  $('page-number').textContent = `${page} / ${pages}`;
  $('previous').disabled = page <= 1;
  $('next').disabled = page >= pages;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const data = await api('/status');
    setSession();
    renderStatus(data);
    if (view === 'monitor') {
      const params = new URLSearchParams({ page, status: $('status-filter').value,
        route: $('route-filter').value, search: $('request-search').value });
      renderRequests(await api(`/requests?${params}`));
    }
  } finally { refreshing = false; }
}
function fillSettings() {
  const form = $('settings-form');
  const s = latest.settings;
  for (const name of ['controlModel', 'upstreamURL', 'maxConcurrent', 'maxQueue', 'sub2apiBase']) {
    form.elements[name].value = s[name] ?? '';
  }
  form.elements.timeoutSeconds.value = s.timeoutMs / 1000;
  form.elements.heartbeatSeconds.value = s.heartbeatMs / 1000;
  form.elements.doneSentinel.checked = s.doneSentinel;
  form.elements.directEdits.checked = s.directEdits;
  for (const [name, statusID, clearName] of [
    ['sub2apiKey', 'admin-key-status', 'clearSub2apiKey'],
  ]) {
    form.elements[name].value = '';
    form.elements[clearName].checked = false;
    $(statusID).textContent = s[`${name}Configured`] ? '已配置' : '未配置';
  }
}
async function switchView(next) {
  if (next === view) return;
  if (view === 'settings' && $('settings-form').dataset.dirty === 'true' &&
      !confirm('有未保存的设置，仍要离开？')) return;
  view = next;
  document.querySelectorAll('.view').forEach(section => { section.hidden = section.id !== `view-${view}`; });
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $('page-title').textContent = { monitor: '请求监控', settings: '转发设置', accounts: '账号诊断' }[view];
  notice('');
  await refresh();
  if (view === 'settings') {
    fillSettings();
    $('settings-form').dataset.dirty = 'false';
    $('save-state').textContent = '';
  }
}
async function loadAccounts() {
  $('account-state').hidden = false;
  $('account-state').textContent = '正在查询…';
  try {
    const params = new URLSearchParams({ page: accountPage, group: $('group-filter').value, search: $('account-search').value });
    const data = await api(`/sub2api/accounts?${params}`);
    accountPages = data.pages;
    $('accounts-body').replaceChildren();
    for (const row of data.items) {
      const tr = element('tr');
      appendCell(tr, row.name, `#${row.id}`);
      appendCell(tr, row.type);
      appendCell(tr, row.status);
      appendCell(tr, row.schedulable === true ? '允许' : row.schedulable === false ? '暂停' : '未知');
      appendCell(tr, row.concurrency);
      appendCell(tr, row.priority);
      appendCell(tr, time(row.rate_limit_reset_at));
      $('accounts-body').append(tr);
    }
    $('account-state').textContent = data.items.length ? '' : '没有匹配的账号';
    $('account-state').hidden = Boolean(data.items.length);
    $('account-count').textContent = `${data.total} 个账号`;
    $('account-page').textContent = `${accountPage} / ${accountPages}`;
    $('accounts-previous').disabled = accountPage <= 1;
    $('accounts-next').disabled = accountPage >= accountPages;
  } catch (error) {
    $('account-state').textContent = error.message;
    $('accounts-body').replaceChildren();
    throw error;
  }
}
$('login-form').onsubmit = async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $('login-error').textContent = '';
  try {
    await api('/login', { method: 'POST', body: JSON.stringify({ key: $('login-key').value }) });
    $('login-key').value = '';
    await refresh();
  } catch (error) { $('login-error').textContent = error.message; }
  finally { button.disabled = false; }
};
$('logout').onclick = () => guarded($('logout'), async () => {
  await api('/logout', { method: 'POST', body: '{}' });
  loggedIn = false;
  $('app').hidden = true;
  $('login').hidden = false;
});
document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => guarded(button, () => switchView(button.dataset.view)); });
$('refresh').onclick = () => guarded($('refresh'), refresh);
$('pause').onclick = () => guarded($('pause'), async () => {
  if (!latest.paused && !confirm('暂停接收新的生图请求？已接收的请求继续执行。')) return;
  await api('/pause', { method: 'POST', body: JSON.stringify({ paused: !latest.paused }) });
  await refresh();
});
$('export').onclick = () => guarded($('export'), async () => {
  const data = await api('/export');
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `bridge-requests-12h-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('status-filter').onchange = () => { page = 1; refresh().catch(e => notice(e.message, true)); };
$('route-filter').onchange = () => { page = 1; refresh().catch(e => notice(e.message, true)); };
let searchTimer;
$('request-search').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { page = 1; refresh().catch(e => notice(e.message, true)); }, 300);
};
$('previous').onclick = () => { page = Math.max(1, page - 1); refresh().catch(e => notice(e.message, true)); };
$('next').onclick = () => { page = Math.min(pages, page + 1); refresh().catch(e => notice(e.message, true)); };
$('settings-form').oninput = () => { $('settings-form').dataset.dirty = 'true'; };
$('settings-form').onsubmit = async event => {
  event.preventDefault();
  const form = $('settings-form');
  await guarded(event.submitter, async () => {
    const values = new FormData(form);
    const patch = {};
    for (const name of ['controlModel', 'upstreamURL', 'sub2apiBase']) patch[name] = String(values.get(name)).trim();
    for (const name of ['maxConcurrent', 'maxQueue']) patch[name] = Number(values.get(name));
    if (!String(values.get('maxConcurrent')).trim()) patch.maxConcurrent = null;
    patch.timeoutMs = Number(values.get('timeoutSeconds')) * 1000;
    patch.heartbeatMs = Number(values.get('heartbeatSeconds')) * 1000;
    patch.doneSentinel = values.has('doneSentinel');
    patch.directEdits = values.has('directEdits');
    for (const [name, clearName] of [['sub2apiKey', 'clearSub2apiKey']]) {
      if (values.has(clearName)) patch[name] = '';
      else if (String(values.get(name)).trim()) patch[name] = String(values.get(name)).trim();
    }
    if ((patch.upstreamURL !== latest.settings.upstreamURL || patch.sub2apiBase !== latest.settings.sub2apiBase) &&
        !confirm('更换上游地址会把对应凭据发送到新地址，确认保存？')) return;
    await api('/settings', { method: 'PUT', body: JSON.stringify(patch) });
    await refresh();
    fillSettings();
    form.dataset.dirty = 'false';
    $('save-state').textContent = '已保存；新请求使用新设置';
    notice('设置已保存');
  });
};
$('load-accounts').onclick = () => guarded($('load-accounts'), () => { accountPage = 1; return loadAccounts(); });
$('load-groups').onclick = () => guarded($('load-groups'), async () => {
  const data = await api('/sub2api/groups');
  $('group-filter').replaceChildren(new Option('全部分组', ''));
  for (const group of data.items) $('group-filter').append(new Option(group.name, group.id));
  notice(`已读取 ${data.items.length} 个分组`);
});
async function changeAccountPage(delta) {
  accountPage = Math.max(1, Math.min(accountPages, accountPage + delta));
  $('accounts-previous').disabled = true;
  $('accounts-next').disabled = true;
  try { await loadAccounts(); } catch (error) { notice(error.message, true); }
  finally {
    $('accounts-previous').disabled = accountPage <= 1;
    $('accounts-next').disabled = accountPage >= accountPages;
  }
}
$('accounts-previous').onclick = () => changeAccountPage(-1);
$('accounts-next').onclick = () => changeAccountPage(1);
$('close-detail').onclick = () => $('detail').close();
$('lookup-usage').onclick = () => guarded($('lookup-usage'), async () => {
  const data = await api(`/sub2api/usage?${new URLSearchParams({ request_id: selected.upstream_request_id })}`);
  $('usage-result').hidden = false;
  $('usage-result').textContent = data.items.length ? JSON.stringify(data.items, null, 2) : '没有匹配记录。上游 ID 可能不一致，或用量记录尚未写入。';
});
for (const [id, icon, label, only] of [
  ['refresh', 'refresh-cw', '刷新', true], ['export', 'download', '导出记录', false],
  ['logout', 'log-out', '退出登录', false], ['close-detail', 'x', '关闭详情', true],
  ['load-accounts', 'search', '查询账号', false],
]) iconButton($(id), icon, label, only);
document.querySelectorAll('#settings-form button[type=submit]').forEach(button => iconButton(button, 'save', '保存设置'));
setInterval(() => {
  if (loggedIn && view === 'monitor' && $('auto-refresh').checked && !document.hidden) {
    refresh().catch(error => notice(error.message, true));
  }
}, 3000);
refresh().catch(error => { if (loggedIn) notice(error.message, true); });
