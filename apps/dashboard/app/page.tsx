'use client';
import { useLanguage, LanguageSwitch } from './i18n/provider';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './components/icons';
import { ThemeToggle } from './components/theme-toggle';
import { HelpDialog } from './components/help-dialog';
import { CleanupDialog } from './components/cleanup-dialog';
type Repository = {
  repo_id: string;
  project_id: string;
  name: string;
  local_path: string | null;
  enabled: boolean;
  observer_status: string;
  memory_count: number;
  memory_bytes: string;
  history_days: number;
  max_memories: number;
  max_memory_bytes: string;
  last_capture_at: string | null;
  last_scan_at: string | null;
};
export default function Page() {
  const { t, locale } = useLanguage();
  const [token, setToken] = useState(''),
    [connected, setConnected] = useState(false),
    [repositories, setRepositories] = useState<Repository[]>([]),
    [selected, setSelected] = useState(''),
    [name, setName] = useState(''),
    [candidates, setCandidates] = useState<string[]>([]),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [days, setDays] = useState(30),
    [localObserver, setLocalObserver] = useState(false);
  const [repoFilter, setRepoFilter] = useState(''),
    [query, setQuery] = useState(''),
    [provider, setProvider] = useState('all'),
    [tab, setTab] = useState('history'),
    [cleanup, setCleanup] = useState<Repository | null>(null),
    [notice, setNotice] = useState<{ count: number; repository: string } | null>(null),
    [copied, setCopied] = useState(false),
    [revision, setRevision] = useState(0);
  const helpTrigger = useRef<HTMLButtonElement | null>(null);
  const [help, setHelp] = useState<'flow' | 'docs' | null>(null);
  const current = repositories.find((r) => r.repo_id === selected);
  const generation = useRef(0);
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(path, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      cache: 'no-store',
    });
    const json = await response.json();
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? t('Token không đúng. Copy nội dung .local/dev-token.')
          : (json.error ?? t('Không tải được dữ liệu')),
      );
    return json;
  }
  async function refresh() {
    const id = ++generation.current;
    const json = await request('/api/repositories');
    if (id !== generation.current) return;
    setRepositories(json.repositories);
    setLocalObserver(json.localObserver);
    return json.repositories as Repository[];
  }
  async function connect() {
    setError('');
    setBusy(true);
    try {
      const repos = await refresh();
      setConnected(true);
      setSelected(repos?.[0]?.repo_id ?? '');
      const suggestions = await request('/api/repositories?candidates=1').catch(() => ({
        names: [],
      }));
      setCandidates(suggestions.names);
    } catch (e: any) {
      setError(e.message);
      setConnected(false);
    } finally {
      setBusy(false);
    }
  }
  async function add() {
    setError('');
    setBusy(true);
    try {
      const added = await request('/api/repositories', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), historyDays: days }),
      });
      await refresh();
      setSelected(added.repo_id);
      setName('');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function toggle(repo: Repository) {
    setError('');
    try {
      await request(`/api/repositories?repoId=${repo.repo_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !repo.enabled }),
      });
      await refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    const poll = async () => {
      try {
        const json = await request('/api/repositories');
        if (!stopped) {
          setRepositories(json.repositories);
          setError('');
        }
      } catch (e: any) {
        if (!stopped) setError(e.message);
      }
    };
    const timer = setInterval(poll, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [connected, token]);
  useEffect(() => {
    if (!connected || !current) {
      setData(null);
      return;
    }
    let stopped = false;
    const load = async () => {
      try {
        const response = await fetch('/api/context', {
          headers: { authorization: `Bearer ${token}`, 'x-project-id': current.project_id },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(t('Không đọc được lịch sử repo'));
        const json = await response.json();
        if (!stopped) setData(json);
      } catch (e: any) {
        if (!stopped) {
          setData(null);
          setError(e.message);
        }
      }
    };
    setData(null);
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [connected, current?.project_id, token, revision]);
  function disconnect() {
    generation.current++;
    setConnected(false);
    setRepositories([]);
    setSelected('');
    setData(null);
    setToken('');
    setNotice(null);
    setError('');
  }
  const memories = (data?.memories ?? []).filter(
    (m: any) =>
      (provider === 'all' || m.provider === provider) &&
      (!query || m.summary.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
  );
  const visibleRepos = repositories.filter((r) =>
    r.name.toLocaleLowerCase().includes(repoFilter.toLocaleLowerCase()),
  );
  const prompt = current ? t('recallPrompt', { repository: current.name }) : '';
  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t('Không thể copy. Bạn có thể chọn và copy nội dung hướng dẫn bên dưới.'));
    }
  }
  function date(value: string | null) {
    if (!value || !Number.isFinite(Date.parse(value))) return t('Chưa có dữ liệu');
    return new Date(value).toLocaleString(locale, {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  function bytes(value: unknown) {
    const n = Number(value) || 0;
    return n < 1048576
      ? `${(n / 1024).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KiB`
      : `${(n / 1048576).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MiB`;
  }
  const usage = current
    ? Math.min(
        100,
        Math.max(
          Number(current.memory_bytes ?? 0) / Number(current.max_memory_bytes ?? 104857600),
          current.memory_count / (current.max_memories ?? 10000),
        ) * 100,
      )
    : 0;
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label={t('SCE trang chủ')}>
          <span className="brand-mark">
            <Icon name="memory" />
          </span>
          <span>
            Shared Context
            <span className="brand-sub">{t('Không gian ghi nhớ cho coding agents')}</span>
          </span>
        </a>
        <div className="topbar-actions">
          <span className="connection-badge">
            <i className={connected ? 'dot live' : 'dot'} />
            {connected ? t('Đã kết nối') : t('Local workspace')}
          </span>
          <LanguageSwitch />
          <ThemeToggle />
          {connected && (
            <button
              className="icon-button"
              aria-label={t('Ngắt kết nối')}
              title={t('Ngắt kết nối')}
              onClick={disconnect}
            >
              <Icon name="logout" />
            </button>
          )}
        </div>
      </header>
      <nav className="help-toolbar" aria-label={t('helpNavigation')}>
        <button
          className="secondary"
          onClick={(event) => {
            helpTrigger.current = event.currentTarget;
            setHelp('flow');
          }}
        >
          <Icon name="play" />
          {t('helpFlow')}
        </button>
        <button
          className="secondary"
          onClick={(event) => {
            helpTrigger.current = event.currentTarget;
            setHelp('docs');
          }}
        >
          <Icon name="book" />
          {t('helpDocs')}
        </button>
      </nav>
      <main>
        {!connected ? (
          <section className="welcome-layout">
            <div className="welcome-copy">
              <span className="section-label">
                <span className="dot live" />
                CODEX + CLAUDE CODE
              </span>
              <h1>
                {' '}
                {t('Mọi phiên làm việc.')} <br />
                <span>{t('Cùng một bộ nhớ.')}</span>
              </h1>
              <p className="lead">
                {' '}
                {t(
                  'Giữ lại quyết định, kết quả và việc đang dở — để phiên tiếp theo bắt nhịp nhanh hơn, dù đang ở dự án nào.',
                )}{' '}
              </p>
              <div className="welcome-steps">
                {[
                  ['folder', t('Thêm repository'), t('Chọn repo local cần quan sát.')],
                  [
                    'memory',
                    t('Lịch sử tự đồng bộ'),
                    t('Nhập trả lời assistant được hỗ trợ từ log local.'),
                  ],
                  ['link', t('Tiếp tục qua MCP'), t('Đọc lịch sử theo tên repo, không cần UUID.')],
                ].map(([icon, title, description], i) => (
                  <div className="welcome-step" key={title}>
                    <span className="step-icon">
                      <Icon name={icon} />
                    </span>
                    <div>
                      <small>
                        {t('BƯỚC 0')}
                        {i + 1}
                      </small>
                      <h3>{title}</h3>
                      <p>{description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <section className="login-card">
              <span className="login-icon">
                <Icon name="shield" />
              </span>
              <h2>{t('Kết nối workspace')}</h2>
              <p className="muted">
                {t('Dùng token trên máy để xem và quản lý các repository của bạn.')}
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void connect();
                }}
              >
                <label htmlFor="access-token">{t('Access token')}</label>
                <input
                  id="access-token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={t('Dán token local của bạn')}
                  required
                />
                <p className="field-hint">
                  {' '}
                  {t('Mở file')} <code>.local/dev-token</code> {t('sau khi chạy')}{' '}
                  <code>npm run dev</code> {t('rồi copy nội dung vào đây.')}{' '}
                </p>
                <button className="full-width" disabled={busy || !token}>
                  {busy ? t('Đang kết nối…') : t('Kết nối workspace')}
                  <Icon name="arrow" />
                </button>
              </form>
              <div className="preservation-note">
                <Icon name="shield" />
                <span>
                  {' '}
                  {t(
                    'Token chỉ nằm trong bộ nhớ phiên trình duyệt, không lưu vào localStorage.',
                  )}{' '}
                </span>
              </div>
            </section>
          </section>
        ) : (
          <>
            <section className="page-heading">
              <div>
                <p className="eyebrow">{t('WORKSPACE / SHARED MEMORY')}</p>
                <h1>{t('Bộ nhớ dự án')}</h1>
                <p className="muted">
                  {t('Theo dõi lịch sử. Nắm bắt quyết định. Tiếp tục công việc.')}
                </p>
              </div>
              <span className="auto-update">
                <Icon name="refresh" /> {t('Tự cập nhật mỗi 5 giây')}{' '}
              </span>
            </section>
            <div className="workspace-grid">
              <aside className="sidebar">
                <section className="panel repo-panel">
                  <div className="panel-heading">
                    <h2>{t('Repositories')}</h2>
                    <span className="count-badge">{repositories.length}</span>
                  </div>
                  <label className="search-input">
                    <Icon name="search" />
                    <span className="sr-only">{t('Tìm repository')}</span>
                    <input
                      value={repoFilter}
                      onChange={(e) => setRepoFilter(e.target.value)}
                      placeholder={t('Tìm repository…')}
                    />
                  </label>
                  <nav className="repo-list" aria-label={t('Repository đang quan sát')}>
                    {visibleRepos.map((repo) => (
                      <button
                        key={repo.repo_id}
                        className={`repo-select ${selected === repo.repo_id ? 'selected' : ''}`}
                        aria-current={selected === repo.repo_id ? 'page' : undefined}
                        onClick={() => {
                          setSelected(repo.repo_id);
                          setQuery('');
                          setProvider('all');
                        }}
                      >
                        <span className="repo-symbol">
                          <Icon name="folder" />
                        </span>
                        <span className="repo-name">
                          {repo.name}
                          <small>
                            <i className={repo.enabled ? 'dot live' : 'dot'} />
                            {repo.enabled
                              ? repo.observer_status === 'partial'
                                ? t('Đồng bộ một phần')
                                : repo.observer_status === 'observing'
                                  ? t('Đang quan sát')
                                  : t('Đang chờ')
                              : t('Tạm dừng')}
                          </small>
                        </span>
                        <span className="count-badge">{repo.memory_count}</span>
                      </button>
                    ))}
                    {visibleRepos.length === 0 && (
                      <p className="sidebar-empty">
                        {repositories.length
                          ? t('Không có repo phù hợp.')
                          : t('Chưa có repository. Thêm repo đầu tiên bên dưới.')}
                      </p>
                    )}
                  </nav>
                </section>
                <section className="panel add-panel">
                  <h2>
                    <Icon name="plus" /> {t('Thêm repository')}{' '}
                  </h2>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void add();
                    }}
                  >
                    <label htmlFor="repo-name">{t('Tên thư mục repo')}</label>
                    <input
                      id="repo-name"
                      list="repo-candidates"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t('Ví dụ: frontend-app')}
                      required
                    />
                    <datalist id="repo-candidates">
                      {candidates.map((n) => (
                        <option key={n} value={n} />
                      ))}
                    </datalist>
                    <label htmlFor="retention-days">{t('Giữ lịch sử')}</label>
                    <select
                      id="retention-days"
                      value={days}
                      onChange={(e) => setDays(Number(e.target.value))}
                    >
                      {[
                        [7, t('7 ngày')],
                        [30, t('30 ngày')],
                        [90, t('90 ngày')],
                        [365, t('1 năm')],
                        [3650, t('10 năm')],
                      ].map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button
                      className="full-width"
                      disabled={busy || !name.trim() || !localObserver}
                    >
                      <Icon name="plus" />
                      {busy ? t('Đang thêm…') : t('Quan sát repo')}
                    </button>
                  </form>
                  <p className="field-hint">
                    {' '}
                    {t(
                      'Bật nhập trích đoạn trả lời assistant đã lọc secret cho repo này. Không nhập prompt, reasoning hay output công cụ.',
                    )}{' '}
                  </p>
                  {!localObserver && (
                    <p className="warning-note">{t('Chạy npm run dev để bật host observer.')}</p>
                  )}
                </section>
              </aside>
              <section className="workspace-content">
                {current ? (
                  <>
                    <section className="repo-heading">
                      <div className="repo-heading-title">
                        <span className="repo-symbol large">
                          <Icon name="folder" />
                        </span>
                        <div>
                          <h2>{current.name}</h2>
                          <p>
                            <Icon name="clock" /> {t('Lần nhập gần nhất:')}{' '}
                            {date(current.last_capture_at)}
                          </p>
                        </div>
                      </div>
                      <div className="action-group">
                        <button className="secondary" onClick={() => toggle(current)}>
                          <Icon name={current.enabled ? 'pause' : 'play'} />
                          {current.enabled ? t('Tạm dừng') : t('Quan sát tiếp')}
                        </button>
                        <button className="danger-outline" onClick={() => setCleanup(current)}>
                          <Icon name="trash" /> {t('Dọn context cũ')}{' '}
                        </button>
                      </div>
                    </section>
                    <section className="stats" aria-label={t('Tổng quan repository')}>
                      {[
                        ['memory', t('Ghi nhớ đã lưu'), current.memory_count],
                        ['link', t('Phiên gần đây'), data?.sessions.length ?? '—'],
                        ['shield', t('Context chủ động'), data?.context_records.length ?? '—'],
                        ['refresh', t('Event chờ xử lý'), data?.processing.pending ?? '—'],
                      ].map(([icon, label, value]) => (
                        <article key={label}>
                          <span className="stat-top">
                            <span>{label}</span>
                            <Icon name={String(icon)} />
                          </span>
                          <strong>
                            {typeof value === 'number' ? value.toLocaleString(locale) : value}
                          </strong>
                        </article>
                      ))}
                    </section>
                    <section className="storage-panel">
                      <div className="storage-summary">
                        <span>
                          <Icon name="shield" /> {t('Lịch sử có giới hạn')}{' '}
                        </span>
                        <strong>
                          {bytes(current.memory_bytes)}{' '}
                          <small>/ {bytes(current.max_memory_bytes ?? 104857600)}</small>
                        </strong>
                      </div>
                      <div
                        className={`usage-track ${usage > 85 ? 'warning' : ''}`}
                        role="meter"
                        aria-label={t('Mức sử dụng lịch sử')}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(usage)}
                      >
                        <span style={{ width: `${usage}%` }} />
                      </div>
                      <div className="storage-meta">
                        <span>
                          {t('retentionSummary', {
                            days: current.history_days,
                            count: (current.max_memories ?? 10000).toLocaleString(locale),
                          })}
                        </span>
                        <span>{t('Tự loại bản cũ nhất khi vượt trần')}</span>
                      </div>
                    </section>
                    <section className="recall-card">
                      <span className="recall-icon">
                        <Icon name="link" />
                      </span>
                      <div>
                        <h3>{t('Tiếp tục ở bất kỳ phiên Codex hoặc Claude nào')}</h3>
                        <p>{prompt}</p>
                      </div>
                      <button
                        className="icon-button"
                        aria-label={t('Copy lời nhắc SCE')}
                        title={t('Copy lời nhắc')}
                        onClick={copyPrompt}
                      >
                        <Icon name={copied ? 'check' : 'copy'} />
                      </button>
                    </section>
                    <section className="panel history-panel">
                      <div className="history-toolbar">
                        <div className="tabs" role="tablist" aria-label={t('Loại dữ liệu')}>
                          {[
                            ['history', t('Lịch sử phiên')],
                            ['context', t('Context')],
                            ['sessions', t('Các phiên')],
                          ].map(([value, label]) => (
                            <button
                              key={value}
                              id={`tab-${value}`}
                              role="tab"
                              aria-selected={tab === value}
                              aria-controls="workspace-tabpanel"
                              onClick={() => setTab(value)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        {tab === 'history' && (
                          <select
                            className="provider-select"
                            aria-label={t('Lọc provider')}
                            value={provider}
                            onChange={(e) => setProvider(e.target.value)}
                          >
                            <option value="all">{t('Tất cả agents')}</option>
                            <option value="codex">Codex</option>
                            <option value="claude">Claude</option>
                          </select>
                        )}
                      </div>
                      <div role="tabpanel" id="workspace-tabpanel" aria-labelledby={`tab-${tab}`}>
                        {tab === 'history' && (
                          <>
                            <div className="history-search">
                              <label className="search-input">
                                <Icon name="search" />
                                <span className="sr-only">{t('Tìm trong lịch sử đã tải')}</span>
                                <input
                                  value={query}
                                  onChange={(e) => setQuery(e.target.value)}
                                  placeholder={t('Tìm trong lịch sử đã tải…')}
                                />
                              </label>
                              <small>{t('Hiển thị tối đa 100 ghi nhớ gần nhất')}</small>
                            </div>
                            {!data ? (
                              <div className="empty compact" role="status">
                                <Icon name="refresh" />
                                <h3>{t('Đang tải lịch sử…')}</h3>
                              </div>
                            ) : memories.length === 0 ? (
                              <div className="empty compact">
                                <span className="empty-icon">
                                  <Icon name="memory" />
                                </span>
                                <h3>
                                  {query
                                    ? t('Không có kết quả phù hợp')
                                    : t('Chưa có lịch sử để hiển thị')}
                                </h3>
                                <p>
                                  {query
                                    ? t('Thử từ khóa hoặc provider khác.')
                                    : t(
                                        'Observer sẽ nhập trả lời assistant phù hợp từ log local. Bạn cũng có thể dùng context_checkpoint qua MCP.',
                                      )}
                                </p>
                              </div>
                            ) : (
                              <div className="timeline">
                                {memories.map((m: any) => (
                                  <article key={m.id} className="memory-card">
                                    <div className="memory-meta">
                                      <span className={`provider-badge ${m.provider}`}>
                                        {m.provider === 'codex' ? 'Codex' : 'Claude'}
                                      </span>
                                      <span className="unverified">{t('Agent report')}</span>
                                      <time dateTime={m.occurred_at}>{date(m.occurred_at)}</time>
                                    </div>
                                    <p className="memory-text">
                                      {m.summary.length > 650
                                        ? m.summary.slice(0, 650) + '…'
                                        : m.summary}
                                    </p>
                                    {m.summary.length > 650 && (
                                      <details>
                                        <summary>{t('Đọc đầy đủ')}</summary>
                                        <p className="memory-text">{m.summary}</p>
                                      </details>
                                    )}
                                    <div className="provenance">
                                      <span>{m.branch ?? t('Chưa rõ branch')}</span>
                                      <code>{m.commit_sha?.slice(0, 10) ?? t('Chưa có SHA')}</code>
                                    </div>
                                    {(m.pending_work.length > 0 || m.blockers.length > 0) && (
                                      <div className="memory-details">
                                        {m.pending_work.length > 0 && (
                                          <section>
                                            <h4>{t('Việc còn lại')}</h4>
                                            <ul>
                                              {m.pending_work.map((v: string, i: number) => (
                                                <li key={i}>{v}</li>
                                              ))}
                                            </ul>
                                          </section>
                                        )}
                                        {m.blockers.length > 0 && (
                                          <section>
                                            <h4>{t('Vướng mắc')}</h4>
                                            <ul>
                                              {m.blockers.map((v: string, i: number) => (
                                                <li key={i}>{v}</li>
                                              ))}
                                            </ul>
                                          </section>
                                        )}
                                      </div>
                                    )}
                                  </article>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                        {tab === 'context' && (
                          <div className="context-list">
                            {!data ? (
                              <p role="status">{t('Đang tải…')}</p>
                            ) : data.context_records.length === 0 && data.handoffs.length === 0 ? (
                              <div className="empty compact">
                                <Icon name="shield" />
                                <h3>{t('Chưa có context chủ động')}</h3>
                                <p>
                                  {' '}
                                  {t(
                                    'Quyết định, contract và handoff được ghi qua MCP sẽ xuất hiện ở đây.',
                                  )}{' '}
                                </p>
                              </div>
                            ) : (
                              <>
                                {data.context_records.map((r: any) => (
                                  <article className="memory-card" key={r.id}>
                                    <div className="memory-meta">
                                      <span className="pill">{t(r.kind)}</span>
                                      <span className="unverified">{t(r.status)}</span>
                                    </div>
                                    <p className="memory-text">{r.content}</p>
                                    <div className="provenance">
                                      <span>{r.branch ?? t('Project-wide')}</span>
                                      <code>{r.commit_sha?.slice(0, 10) ?? t('Chưa có SHA')}</code>
                                    </div>
                                  </article>
                                ))}
                                {data.handoffs.map((h: any) => (
                                  <article className="memory-card" key={h.id}>
                                    <span className="pill">{t('Handoff')}</span>
                                    <p className="memory-text">{h.summary}</p>
                                    <ul>
                                      {h.pending_work.map((v: string, i: number) => (
                                        <li key={i}>{v}</li>
                                      ))}
                                    </ul>
                                  </article>
                                ))}
                              </>
                            )}
                          </div>
                        )}
                        {tab === 'sessions' && (
                          <div className="session-list">
                            {!data ? (
                              <p role="status">{t('Đang tải…')}</p>
                            ) : data.sessions.length === 0 ? (
                              <div className="empty compact">
                                <Icon name="link" />
                                <h3>{t('Chưa có phiên nào')}</h3>
                                <p>{t('Phiên agent có ghi nhớ sẽ tự xuất hiện tại đây.')}</p>
                              </div>
                            ) : (
                              data.sessions.map((s: any) => (
                                <article key={s.id} className="session-row">
                                  <span className={`provider-badge ${s.provider}`}>
                                    {s.provider === 'codex' ? 'Codex' : 'Claude'}
                                  </span>
                                  <code>{s.external_session_id}</code>
                                  <time>{date(s.last_seen_at)}</time>
                                </article>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    </section>
                  </>
                ) : (
                  <section className="panel empty workspace-empty">
                    <span className="empty-icon">
                      <Icon name="folder" />
                    </span>
                    <h2>{t('Không gian mới, sẵn sàng ghi nhớ.')}</h2>
                    <p>
                      {' '}
                      {t(
                        'Thêm repository đầu tiên ở bên trái để bắt đầu kết nối lịch sử giữa các phiên agent.',
                      )}{' '}
                    </p>
                    <span className="pill">
                      <Icon name="shield" /> {t('Chỉ quan sát những repo bạn chọn')}{' '}
                    </span>
                  </section>
                )}
              </section>
            </div>
          </>
        )}
        {error && (
          <div className="toast error" role="alert">
            <Icon name="alert" />
            <span>{t(error)}</span>
            <button
              className="icon-button"
              aria-label={t('Đóng thông báo lỗi')}
              onClick={() => setError('')}
            >
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="toast success" role="status">
            <Icon name="check" />
            <span>
              {t('cleanupDone', {
                count: notice.count.toLocaleString(locale),
                repository: notice.repository,
              })}
            </span>
            <button
              className="icon-button"
              aria-label={t('Đóng thông báo')}
              onClick={() => setNotice(null)}
            >
              ×
            </button>
          </div>
        )}
        <footer>
          <span>
            <Icon name="shield" />{' '}
            {t('Context là dữ liệu tham khảo, luôn giữ branch và provenance.')}{' '}
          </span>
          <span>{t('Shared Context Engine · Local workspace')}</span>
        </footer>
      </main>
      {help && (
        <HelpDialog
          kind={help}
          onClose={() => {
            setHelp(null);
            requestAnimationFrame(() => helpTrigger.current?.focus());
          }}
        />
      )}
      {cleanup && (
        <CleanupDialog
          repository={cleanup}
          request={request}
          onClose={() => setCleanup(null)}
          onComplete={(message) => {
            setCleanup(null);
            setNotice(message);
            setRevision((n) => n + 1);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
