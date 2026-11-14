/**
 * Single-series daily bar chart (HTML and CSS, server-rendered, no client JS),
 * so its labels stay readable at any width. Ink bars with the latest day in
 * ember, a quiet grid, a per-bar hover tooltip and a table view for screen
 * readers and exact values. It plots the measured values it is given and never
 * adds estimates, averages or trend lines.
 */

/** Rounds up to a clean axis maximum, so the middle grid line lands on a real value. */
function niceCeiling(value: number): number {
  if (value <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => value <= s * magnitude) ?? 10;
  return step * magnitude;
}

function shortDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export default function DailyBarChart({
  title,
  series,
  unit,
  formatValue = (n: number) => String(n),
}: {
  title: string;
  series: Array<{ day: string; count: number }>;
  unit: string;
  /** Formats values in labels, tooltips and the table (e.g. currency). */
  formatValue?: (value: number) => string;
}) {
  const max = Math.max(0, ...series.map((p) => p.count));
  const top = niceCeiling(max);
  const total = series.reduce((n, p) => n + p.count, 0);
  const latest = series[series.length - 1];
  // Only label the middle line when it is a whole number (no "2.5 orders").
  const ticks = Number.isInteger(top / 2) ? [1, 0.5, 0] : [1, 0];

  return (
    <figure className="min-w-0">
      <figcaption className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-slate-900">{title}</span>
        <span className="text-xs text-slate-500">
          {formatValue(total)} {unit} in {series.length} days
        </span>
      </figcaption>
      <div
        role="img"
        aria-label={`${title}: ${formatValue(total)} ${unit} over ${series.length} days, peak ${formatValue(max)} per day${latest ? `, latest day ${formatValue(latest.count)}` : ""}`}
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2"
      >
        <div aria-hidden="true" className="flex h-36 flex-col justify-between text-right text-[11px] leading-none tabular-nums text-slate-500">
          {ticks.map((f) => (
            <span key={f}>{formatValue(top * f)}</span>
          ))}
        </div>
        <div className="relative h-36 min-w-0 border-b border-slate-200">
          <div aria-hidden="true" className="absolute inset-x-0 top-0 border-t border-slate-100" />
          {ticks.length === 3 && <div aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-slate-100" />}
          <div aria-hidden="true" className="absolute inset-0 flex items-end gap-px sm:gap-0.5">
            {series.map((point, i) => {
              const isLatest = i === series.length - 1;
              const height = top > 0 ? (point.count / top) * 100 : 0;
              // Keeps the tooltip on the chart near its edges.
              const position = i < series.length / 3 ? "left-0" : i > (series.length * 2) / 3 ? "right-0" : "left-1/2 -translate-x-1/2";
              return (
                <div key={point.day} className="group relative flex h-full min-w-0 flex-1 items-end justify-center">
                  {point.count > 0 && (
                    <div
                      className={`w-full max-w-[18px] rounded-t-[3px] transition-colors ${isLatest ? "bg-ember" : "bg-slate-900 group-hover:bg-ember"}`}
                      style={{ height: `${height}%`, minHeight: "2px" }}
                    />
                  )}
                  <div className={`pointer-events-none absolute top-0 z-10 hidden whitespace-nowrap rounded-lg bg-ink px-2 py-1 text-[11px] font-medium text-white shadow-lg group-hover:block ${position}`}>
                    {shortDay(point.day)}: {formatValue(point.count)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {series.length > 0 && (
          <div aria-hidden="true" className="col-start-2 mt-1.5 flex justify-between gap-2 text-[11px] text-slate-500">
            <span>{shortDay(series[0].day)}</span>
            {latest && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-sm bg-ember" />
                {shortDay(latest.day)}: {formatValue(latest.count)}
              </span>
            )}
          </div>
        )}
      </div>
      <details className="mt-2 text-xs text-slate-600">
        <summary className="inline-flex min-h-10 cursor-pointer select-none items-center rounded font-medium text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2">
          Show as table
        </summary>
        <div className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-slate-200">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-slate-50 font-medium text-slate-500">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-medium">Day (UTC)</th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">{unit}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {series.map((p) => (
                <tr key={p.day}>
                  <td className="px-3 py-1.5">{p.day}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatValue(p.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
