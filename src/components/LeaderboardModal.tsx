import { Trophy, X, RefreshCw, Cloud, HardDrive } from 'lucide-react';
import { DIFFICULTY_PROFILES } from '../engine/enemyAI';
import type { LeaderboardEntry } from '../engine/types';
import { formatScoreFa, toFaNum } from '../utils/formatFa';

interface LeaderboardModalProps {
  open: boolean;
  entries: LeaderboardEntry[];
  source: 'arvan-edge' | 'local';
  loading: boolean;
  highlightId: string | null;
  onRefresh: () => void;
  onClose: () => void;
}

export function LeaderboardModal({
  open,
  entries,
  source,
  loading,
  highlightId,
  onRefresh,
  onClose,
}: LeaderboardModalProps) {
  if (!open) return null;

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#050c14]/84 p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-label="جدول ۱۰۰ خلبان برتر"
    >
      <div className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-amber-400/30 bg-[#0b1624] text-slate-100 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200/12 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-amber-400/40 bg-amber-500/15 text-amber-400">
              <Trophy className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-black text-white sm:text-xl">
                جدول ۱۰۰ خلبان و فرمانده برتر
              </h2>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-300">
                {source === 'arvan-edge' ? (
                  <>
                    <Cloud className="h-3.5 w-3.5 text-emerald-400" />
                    <span className="text-emerald-300">همگام با لبه ابری آروان (S3)</span>
                  </>
                ) : (
                  <>
                    <HardDrive className="h-3.5 w-3.5 text-sky-400" />
                    <span className="text-sky-300">حالت آفلاین · ذخیره محلی مرورگر</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              aria-label="بروزرسانی جدول"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200/18 bg-[#122236] text-slate-200 transition-colors hover:border-amber-400/60 hover:text-amber-300 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="بستن جدول"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200/18 bg-[#122236] text-slate-200 transition-colors hover:border-red-400/60 hover:text-red-300 cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Ranked Table */}
        <div className="flex-1 overflow-y-auto px-4 py-3 sm:px-5">
          {loading && entries.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-300">
              در حال دریافت رتبه‌بندی برترین‌ها...
            </div>
          ) : entries.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-400">
              هنوز رکوردی ثبت نشده است. اولین خلبان یا فرمانده برتر باشید!
            </div>
          ) : (
            <table className="w-full border-collapse text-right text-xs sm:text-sm">
              <thead>
                <tr className="border-b border-slate-200/12 text-[11px] font-semibold text-slate-400">
                  <th className="py-2.5 pl-2 pr-2 text-center w-12">رتبه</th>
                  <th className="py-2.5 px-2">نام و حالت نبرد</th>
                  <th className="py-2.5 px-2">امتیاز</th>
                  <th className="py-2.5 px-2 text-center">موج / انهدام</th>
                  <th className="py-2.5 px-2 text-center">سختی</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, idx) => {
                  const rank = idx + 1;
                  const isHighlighted = highlightId !== null && entry.id === highlightId;
                  const isTank = entry.mode === 'tank';
                  const rankColor =
                    rank === 1
                      ? 'bg-amber-400 text-slate-950'
                      : rank === 2
                      ? 'bg-slate-300 text-slate-950'
                      : rank === 3
                      ? 'bg-amber-700 text-amber-50'
                      : 'bg-slate-800/90 text-slate-300';

                  return (
                    <tr
                      key={entry.id}
                      className={`border-b border-slate-200/8 transition-colors ${
                        isHighlighted
                          ? 'bg-amber-500/18 text-white'
                          : 'hover:bg-slate-800/40'
                      }`}
                    >
                      <td className="py-2.5 pl-2 pr-2 text-center">
                        <span
                          className={`tabular-nums inline-flex h-6 min-w-[24px] items-center justify-center rounded-md px-1.5 text-xs font-black ${rankColor}`}
                        >
                          {toFaNum(rank)}
                        </span>
                      </td>
                      <td className="py-2.5 px-2 font-bold text-slate-100">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span>{entry.callsign}</span>
                          <span
                            className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold ${
                              isTank
                                ? 'border-amber-400/40 bg-amber-500/15 text-amber-300'
                                : 'border-sky-400/40 bg-sky-500/15 text-sky-300'
                            }`}
                          >
                            {isTank ? 'تانک' : 'جنگنده'}
                          </span>
                          {isHighlighted && (
                            <span className="rounded bg-emerald-400/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
                              رکورد شما
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="tabular-nums py-2.5 px-2 font-black text-amber-400">
                        {formatScoreFa(entry.score)}
                      </td>
                      <td className="tabular-nums py-2.5 px-2 text-center text-slate-200">
                        {toFaNum(entry.wave)} / {toFaNum(entry.kills)}
                      </td>
                      <td className="py-2.5 px-2 text-center text-xs text-slate-300">
                        {DIFFICULTY_PROFILES[entry.difficulty]?.labelFa || 'متوسط'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-200/12 bg-[#09121e] px-5 py-3 text-xs text-slate-400">
          <span>نمایش برترین خلبانان و فرماندهان ثبت‌شده (حداکثر ۱۰۰ نفر)</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-slate-800 px-4 py-1.5 font-bold text-slate-100 transition-colors hover:bg-slate-700 cursor-pointer"
          >
            بستن
          </button>
        </div>
      </div>
    </div>
  );
}
