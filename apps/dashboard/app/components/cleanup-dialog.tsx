'use client';
import { useLanguage } from '../i18n/provider';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
type Preview = { eligibleCount: number; eligibleBytes: string; cutoff: string; repository: string };
export function CleanupDialog({
  repository,
  onClose,
  onComplete,
  request,
}: {
  repository: { repo_id: string; name: string };
  onClose: () => void;
  onComplete: (message: { count: number; repository: string }) => void;
  request: (path: string, init?: RequestInit) => Promise<any>;
}) {
  const { t, locale } = useLanguage();
  const dialog = useRef<HTMLDialogElement>(null),
    requestId = useRef(0);
  const [days, setDays] = useState(30),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  async function inspect() {
    const id = ++requestId.current;
    setBusy(true);
    setError('');
    try {
      const result = await request(
        `/api/repositories?repoId=${repository.repo_id}&action=cleanup`,
        { method: 'POST', body: JSON.stringify({ olderThanDays: days, preview: true }) },
      );
      if (id === requestId.current) setPreview(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const result = await request(
        `/api/repositories?repoId=${repository.repo_id}&action=cleanup`,
        {
          method: 'POST',
          body: JSON.stringify({
            olderThanDays: days,
            preview: false,
            cutoff: preview.cutoff,
            confirmation: repository.name,
          }),
        },
      );
      onComplete({ count: result.eligibleCount, repository: repository.name });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="cleanup-dialog"
      aria-labelledby="cleanup-title"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <div className="dialog-heading">
        <span className="danger-icon">
          <Icon name="trash" />
        </span>
        <div>
          <p className="eyebrow">{t('QUẢN LÝ LỊCH SỬ')}</p>
          <h2 id="cleanup-title">{t('Dọn context cũ')}</h2>
        </div>
      </div>
      <p>
        {' '}
        {t('Chỉ xóa ghi nhớ phiên của')} <strong>{repository.name}</strong>{' '}
        {t('trước mốc đã chọn. Thao tác không thể hoàn tác.')}{' '}
      </p>
      <label>
        {' '}
        {t('Ghi nhớ cũ hơn')}{' '}
        <select
          value={days}
          disabled={busy}
          onChange={(e) => {
            setDays(Number(e.target.value));
            setPreview(null);
            setError('');
            requestId.current++;
          }}
        >
          <option value={1}>{t('1 ngày')}</option>
          <option value={7}>{t('7 ngày')}</option>
          <option value={30}>{t('30 ngày')}</option>
          <option value={90}>{t('90 ngày')}</option>
          <option value={365}>{t('1 năm')}</option>
        </select>
      </label>
      <div className="preservation-note">
        <Icon name="shield" />
        <span>
          {t('Giữ nguyên quyết định, contract, handoff chủ động và event đang chờ xử lý.')}
        </span>
      </div>
      {preview && (
        <div className="cleanup-preview" role="status">
          <strong>
            {t(preview.eligibleCount === 1 ? 'memoryCountOne' : 'memoryCount', {
              count: preview.eligibleCount.toLocaleString(locale),
            })}
          </strong>
          <span>
            {(Number(preview.eligibleBytes) / 1048576).toLocaleString(locale, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{' '}
            {t('MiB nội dung · trước')} {new Date(preview.cutoff).toLocaleString(locale)}
          </span>
          {preview.eligibleCount === 0 && <p>{t('Không có lịch sử phù hợp để xóa.')}</p>}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
      <div className="dialog-actions">
        <button className="secondary" disabled={busy} onClick={onClose}>
          {' '}
          {t('Hủy')}{' '}
        </button>
        {!preview ? (
          <button disabled={busy} onClick={inspect}>
            {busy ? t('Đang kiểm tra…') : t('Xem trước')}
          </button>
        ) : (
          <button className="danger" disabled={busy || preview.eligibleCount === 0} onClick={clear}>
            <Icon name="trash" />
            {busy ? t('Đang dọn…') : t('Xác nhận dọn lịch sử')}
          </button>
        )}
      </div>
    </dialog>
  );
}
