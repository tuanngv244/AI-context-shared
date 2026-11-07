import { test, expect, type Page } from '@playwright/test';
const repo = {
  repo_id: '33333333-3333-4333-8333-333333333333',
  project_id: '22222222-2222-4222-8222-222222222222',
  name: 'demo-frontend',
  local_path: '/workspace/demo-frontend',
  enabled: true,
  observer_status: 'observing',
  memory_count: 2,
  memory_bytes: '8200',
  history_days: 30,
  max_memories: 10000,
  max_memory_bytes: '104857600',
  last_capture_at: new Date().toISOString(),
};
async function mockWorkspace(page: Page) {
  let deleted = 0,
    previews = 0;
  await page.route('**/api/repositories*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('action') === 'cleanup') {
      const body = route.request().postDataJSON();
      if (body.preview) previews++;
      else {
        expect(body.confirmation).toBe(repo.name);
        expect(body.cutoff).toBeTruthy();
        deleted++;
      }
      return route.fulfill({
        json: {
          repository: repo.name,
          preview: body.preview,
          eligibleCount: 1,
          eligibleBytes: '4096',
          cutoff: '2026-01-01T00:00:00.000Z',
        },
      });
    }
    return route.fulfill({
      json: url.searchParams.has('candidates')
        ? { names: [repo.name] }
        : { repositories: [{ ...repo, memory_count: deleted ? 1 : 2 }], localObserver: true },
    });
  });
  await page.route('**/api/context', (route) =>
    route.fulfill({
      json: {
        sessions: [
          {
            id: 's1',
            provider: 'codex',
            external_session_id: 'demo-session',
            last_seen_at: new Date().toISOString(),
          },
        ],
        memories: [
          {
            id: 'm1',
            provider: 'codex',
            summary:
              'Đã hoàn thành hợp đồng refresh token. Cần xác nhận cookie domain trước khi triển khai.',
            pending_work: ['Bổ sung kiểm thử tích hợp'],
            blockers: [],
            branch: 'feat/auth',
            commit_sha: 'abcdef1234567',
            occurred_at: new Date().toISOString(),
          },
          {
            id: 'm2',
            provider: 'claude',
            summary: 'Đã rà soát giao diện đăng nhập và thống nhất trạng thái lỗi với backend.',
            pending_work: [],
            blockers: ['Chờ xác nhận API'],
            branch: 'feat/login',
            commit_sha: null,
            occurred_at: new Date().toISOString(),
          },
        ],
        context_records: [],
        handoffs: [],
        processing: { pending: 0 },
      },
    }),
  );
  return { counts: () => ({ deleted, previews }) };
}
async function login(page: Page) {
  await page.getByRole('button', { name: 'Tiếng Việt', exact: true }).click();
  await page.getByLabel('Token truy cập', { exact: true }).fill('ui-test-token');
  await page.getByRole('button', { name: 'Kết nối workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'demo-frontend', exact: true })).toBeVisible();
}
test('light/dark/system modes persist and follow the operating system', async ({ page }) => {
  await mockWorkspace(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await login(page);
  await page.getByRole('button', { name: 'Giao diện sáng', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(
    page.getByText('Đã hoàn thành hợp đồng refresh token.', { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: '.local/ui-preview-light.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Giao diện tối', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({
    path: '.local/ui-preview-dark.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Giao diện tối', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Giao diện hệ thống', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
test('cleanup requires preview and confirmation, and cancellation never deletes', async ({
  page,
}) => {
  const mock = await mockWorkspace(page);
  await page.goto('/');
  await login(page);
  await page.getByRole('button', { name: 'Dọn context cũ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Dọn context cũ' });
  await expect(dialog).toBeVisible();
  expect(mock.counts().deleted).toBe(0);
  await dialog.getByLabel('Ghi nhớ cũ hơn').selectOption('7');
  await dialog.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await expect(dialog.getByText('1 ghi nhớ', { exact: true })).toBeVisible();
  expect(mock.counts().deleted).toBe(0);
  await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(mock.counts().deleted).toBe(0);
  await page.getByRole('button', { name: 'Dọn context cũ', exact: true }).click();
  await dialog.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await dialog.getByRole('button', { name: 'Xác nhận dọn lịch sử', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText('Đã dọn 1 ghi nhớ cũ của demo-frontend.', { exact: true }),
  ).toBeVisible();
  expect(mock.counts()).toEqual({ deleted: 1, previews: 2 });
});
test('mobile layout has no horizontal overflow and history filtering works', async ({ page }) => {
  await mockWorkspace(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await login(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByLabel('Lọc provider').selectOption('claude');
  await expect(
    page.getByText('Đã rà soát giao diện đăng nhập và thống nhất trạng thái lỗi với backend.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('Đã hoàn thành hợp đồng refresh token.', { exact: false }),
  ).not.toBeVisible();
  await page.screenshot({
    path: '.local/ui-preview-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('English is the default and EN/VI selection survives reload without translating user content', async ({
  page,
}) => {
  await mockWorkspace(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Connect workspace', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'English', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByLabel('Access token', { exact: true }).fill('ui-test-token');
  await page.getByRole('button', { name: 'Connect workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project memory', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear old context', exact: true })).toBeVisible();
  await expect(
    page.getByText('Đã hoàn thành hợp đồng refresh token.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Tiếng Việt', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await expect(page.getByRole('heading', { name: 'Bộ nhớ dự án', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await expect(page.getByRole('heading', { name: 'Kết nối workspace', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Connect workspace', exact: true })).toBeVisible();
});
test('cleanup dialog and validation messages follow the selected language', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto('/');
  await page.getByLabel('Access token', { exact: true }).fill('ui-test-token');
  await page.getByRole('button', { name: 'Connect workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Clear old context', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Clear old context' });
  await expect(dialog.getByLabel('Memories older than')).toBeVisible();
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(dialog.getByText('1 memory', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Tiếng Việt', exact: true }).click();
  await page.getByRole('button', { name: 'Dọn context cũ', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Ghi nhớ cũ hơn')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Hủy', exact: true }).click();
  await page.getByRole('button', { name: 'Ngắt kết nối', exact: true }).click();
  await page.route('**/api/repositories', (route) =>
    route.fulfill({ status: 401, json: { error: 'Authentication required' } }),
  );
  await page.getByLabel('Token truy cập', { exact: true }).fill('invalid');
  await page.getByRole('button', { name: 'Kết nối workspace', exact: true }).click();
  await expect(page.locator('.toast[role=alert]')).toContainText('Token không đúng');
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.locator('.toast[role=alert]')).toContainText('Invalid token');
});

test('help dialogs explain flow and storage, docs localize and restore focus', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'How it works', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Play animation' })).toBeVisible();
  await expect(dialog.locator('.flow-detail')).toContainText('1. Work in your repo');
  await dialog.getByRole('button', { name: 'Next step' }).click();
  await expect(dialog.locator('.flow-detail')).toContainText('2. Capture & redact');
  await dialog.getByRole('button', { name: '5. Recall through MCP' }).click();
  await expect(dialog.locator('.flow-detail')).toContainText('project B');
  await expect(dialog).toContainText('.local/postgres');
  await expect(dialog).toContainText('postgres_data');
  await expect(dialog).toContainText('~/.sce/spool.sqlite');
  await dialog.getByRole('button', { name: 'Play animation' }).click();
  await expect(dialog.getByRole('button', { name: 'Pause animation' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Pause animation' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'How it works', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Docs', exact: true }).click();
  await expect(dialog).toContainText('npm run mcp:config');
  await expect(dialog).toContainText('Author: tuanngv244');
  await expect(dialog.getByRole('link', { name: 'GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/tuanngv244',
  );
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Tiếng Việt', exact: true }).click();
  await page.getByRole('button', { name: 'Hướng dẫn', exact: true }).click();
  await expect(dialog).toContainText('Tác giả: tuanngv244');
  await expect(dialog.getByRole('link', { name: 'GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/tuanngv244',
  );
  await dialog.getByRole('button', { name: 'Đóng', exact: true }).click();
  await page.getByRole('button', { name: 'Luồng hoạt động', exact: true }).click();
  await expect(dialog).toContainText('Dữ liệu được lưu ở đâu?');
});

test('help modals fit mobile in dark mode', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/');
  for (const name of ['How it works', 'Docs']) {
    await page.getByRole('button', { name, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  }
});

test('flow nodes keep icons and labels aligned across desktop and mobile', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'How it works', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const nodes = dialog.locator('.flow-map li');
  await expect(nodes).toHaveCount(6);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const boxes = await nodes.evaluateAll((items) =>
      items.map((item) => {
        const icon = item.querySelector('.flow-node')!.getBoundingClientRect();
        const label = item.querySelector('button > span:last-child')!.getBoundingClientRect();
        return {
          icon: { x: icon.x, y: icon.y, width: icon.width, height: icon.height },
          label: { x: label.x, y: label.y, width: label.width, height: label.height },
        };
      }),
    );
    for (const { icon, label } of boxes) {
      expect(icon.width).toBe(48);
      expect(icon.height).toBe(48);
      if (width > 760) expect(label.y).toBeGreaterThanOrEqual(icon.y + icon.height);
      else expect(label.x).toBeGreaterThanOrEqual(icon.x + icon.width);
    }
    await dialog.screenshot({ path: `.local/flow-${width}.png` });
  }
});
