import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  ArrowLeft,
  X,
  ChevronRight,
  ChevronDown,
  Lock,
  Hash,
  Quote,
  BookOpen,
  ExternalLink,
  Shield,
  AlertCircle,
  CheckCircle2,
  TrendingUp,
  TrendingDown,
  Minus,
  Plus,
  Eye,
  ArrowRight,
  Layers,
  Target,
  Zap,
  Filter,
  RefreshCw,
  Info,
  Search,
  MoreHorizontal,
  ShieldCheck,
  ThumbsUp,
  ThumbsDown,
  Bookmark,
  Clock,
} from 'lucide-react';

export default function AdversarialLens() {
  const [isDesktop, setIsDesktop] = useState(false);
  const [view, setView] = useState('overview'); // overview | counter

  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 1024);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 antialiased" style={{ fontFamily: 'Inter, -apple-system, system-ui, sans-serif' }}>
      <div className="flex flex-col min-h-screen">
        {/* Header */}
        <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-200">
          <div className="px-4 lg:px-6 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <button className="h-9 w-9 -ml-2 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-700">
                <ArrowLeft className="w-5 h-5" strokeWidth={2} />
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <Sparkles className="w-3.5 h-3.5 text-slate-900" strokeWidth={2} />
                  <h1 className="text-base font-semibold tracking-tight">Adversarial Lens</h1>
                </div>
                <div className="text-xs text-slate-500 truncate tabular-nums">
                  RC-002 · Comprehensive WBV assessment
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button className="h-9 px-3 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50 hidden sm:inline-flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5" strokeWidth={2} />
                Regenerate
              </button>
              <button className="h-9 w-9 rounded-md hover:bg-slate-100 flex items-center justify-center text-slate-600">
                <MoreHorizontal className="w-[18px] h-[18px]" strokeWidth={2} />
              </button>
            </div>
          </div>
        </header>

        {/* Provenance strip */}
        <div className="bg-white border-b border-slate-200 px-4 lg:px-6 py-2.5">
          <div className="flex items-center gap-3 text-[11px] text-slate-500 overflow-x-auto">
            <span className="flex items-center gap-1.5 shrink-0">
              <Layers className="w-3 h-3" strokeWidth={2.25} />
              <span>3 predictions</span>
            </span>
            <span className="text-slate-300 shrink-0">·</span>
            <span className="flex items-center gap-1.5 shrink-0">
              <Target className="w-3 h-3" strokeWidth={2.25} />
              <span>Pattern data + AI</span>
            </span>
            <span className="text-slate-300 shrink-0">·</span>
            <span className="flex items-center gap-1.5 shrink-0 tabular-nums">
              <Clock className="w-3 h-3" strokeWidth={2.25} />
              <span>Generated 2 minutes ago</span>
            </span>
            <span className="text-slate-300 shrink-0">·</span>
            <span className="flex items-center gap-1.5 shrink-0 font-mono tabular-nums">
              <Hash className="w-3 h-3" strokeWidth={2.25} />
              <span>analysis.c8f2a17b</span>
            </span>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-4 lg:px-6 py-5 lg:py-8 pb-24">
            {/* Strategic summary card */}
            <div className="bg-slate-900 text-white rounded-xl p-5 lg:p-6 mb-6 lg:mb-8 relative overflow-hidden">
              <div className="absolute -top-12 -right-12 w-48 h-48 bg-gradient-to-br from-slate-700 to-transparent rounded-full opacity-50" />
              <div className="relative">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center">
                    <Target className="w-4 h-4 text-amber-300" strokeWidth={2.25} />
                  </div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-300">
                    Strategic summary
                  </div>
                </div>
                <p className="text-base lg:text-lg text-white leading-relaxed mb-4 max-w-3xl">
                  Management will most likely <span className="font-semibold underline decoration-amber-300/50 underline-offset-4">deflect</span> by claiming
                  the 2015 study is sufficient. Strong rebuttal exists in JHSC minutes and standards gap.
                  Walking in with the ISO 2631-5 distinction puts you ahead at the start.
                </p>
                <div className="flex flex-wrap gap-2">
                  <SummaryChip label="Likelihood of acceptance" value="22%" trend="down" />
                  <SummaryChip label="Strength of rebuttal" value="High" />
                  <SummaryChip label="MLITSD precedent" value="3 orders" />
                </div>
              </div>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-1 -mx-4 px-4 lg:mx-0 lg:px-0">
              <FilterChip active label="All predictions" count={3} />
              <FilterChip label="High likelihood" count={1} />
              <FilterChip label="Medium" count={2} />
              <FilterChip label="With precedent" count={2} />
            </div>

            {/* Predictions */}
            <div className="space-y-4">
              <Prediction
                rank={1}
                likelihood="High"
                likelihoodScore={78}
                category="Deflection"
                headline="We already conducted a WBV study in 2015."
                source="Pattern data — similar response in 47 of 61 documented cases"
                rebuttal={[
                  { text: 'The 2015 FJD Engineering study is in draft form, not finalized.', citations: [] },
                  { text: 'It applied ISO 2631-1 only; the trench drain hazard requires ISO 2631-5 (multi-shock).', citations: ['iso-2631-5'] },
                  { text: 'It never measured the trench drain crossing — the operative hazard zone.', citations: [] },
                  { text: 'It is eleven years out of date; the duty under OHSA s. 25(2)(h) is ongoing.', citations: ['ohsa-s25-2-h'] },
                ]}
                precedent="MLITSD has issued orders requiring re-assessment when prior studies failed to apply current standards (3 orders in dairy/food processing sector, 2021-2023)."
                preEmpt="Open the meeting by acknowledging the 2015 study and pivoting immediately to the standards gap. Don't let management present it as new information."
              />

              <Prediction
                rank={2}
                likelihood="Medium"
                likelihoodScore={54}
                category="Internal scope"
                headline="We will conduct an internal assessment instead of hiring an external assessor."
                source="Pattern data — common cost-deferral move when external assessment cost is the friction"
                rebuttal={[
                  { text: 'Internal assessment is acceptable only if the assessor is qualified to apply ISO 2631-5.', citations: ['iso-2631-5'] },
                  { text: 'The recommendation specifies ROH/CIH/CPE qualification because multi-shock evaluation requires documented competency.', citations: [] },
                  { text: 'No internal staff member currently holds these qualifications per Annex A of the recommendation.', citations: [] },
                  { text: 'Workers may refuse an internal assessment that does not meet this bar under s. 43.', citations: [] },
                ]}
                precedent="Standard arbitration position: where a recognized standard requires specific competency, the qualification of the assessor is part of the duty to assess."
                preEmpt="If management proposes internal assessment, ask specifically which staff member would conduct it and request their credentials in writing. Refusal to name the assessor itself becomes evidence."
              />

              <Prediction
                rank={3}
                likelihood="Medium"
                likelihoodScore={41}
                category="Procedural"
                headline="The hazard is not unmitigated; an SWP exists."
                source="Likely deflection given March 26 JHSC minutes context"
                rebuttal={[
                  { text: 'The Safe Work Procedure has not been finalized per the March 26 JHSC minutes.', citations: [] },
                  { text: 'Management confirmed in those same minutes that PM/midnight shift staffing prevents consistent use of the counterbalance forklift alternative.', citations: [] },
                  { text: 'A draft SWP does not satisfy the s. 25(2)(h) duty to take every precaution reasonable.', citations: ['ohsa-s25-2-h'] },
                  { text: 'The hazard remains operative on at least two of three shifts, by management\'s own admission.', citations: [] },
                ]}
                precedent="Multiple cases support that a procedural control unimplemented in practice is not a control."
                preEmpt="Bring the March 26 minutes. The admission is in writing on their side."
              />
            </div>

            {/* Aftermath: track what management actually did */}
            <div className="mt-8 lg:mt-10 p-4 lg:p-5 rounded-xl border border-slate-200 bg-white">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-4 h-4 text-slate-700" strokeWidth={2} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-900 mb-1">When the response comes in</div>
                  <div className="text-xs text-slate-500 leading-relaxed">
                    Mark which predictions actually showed up. Outcomes train future predictions and feed the pattern data shared across worker-side JHSC reps.
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-4">
                <button className="h-11 rounded-md bg-slate-50 text-xs font-medium text-slate-700 border border-slate-200 active:bg-slate-100 inline-flex items-center justify-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" strokeWidth={2} />
                  Mark accurate
                </button>
                <button className="h-11 rounded-md bg-slate-50 text-xs font-medium text-slate-700 border border-slate-200 active:bg-slate-100 inline-flex items-center justify-center gap-1.5">
                  <X className="w-3.5 h-3.5" strokeWidth={2} />
                  Didn't materialize
                </button>
              </div>
            </div>

            {/* Disclosure */}
            <div className="mt-6 text-[11px] text-slate-500 leading-relaxed">
              <div className="flex items-start gap-2">
                <Info className="w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0" strokeWidth={2} />
                <div>
                  Predictions are generated from pattern data accumulated across recommendations + an AI model
                  (Anthropic API). Predictions are advisory, not deterministic — management may respond in
                  unexpected ways. Treat as preparation, not certainty.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// =================== Components ===================

function SummaryChip({ label, value, trend }) {
  const TrendIcon = trend === 'down' ? TrendingDown : trend === 'up' ? TrendingUp : null;
  return (
    <div className="bg-white/10 backdrop-blur rounded-md px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-white/60 mb-0.5">{label}</div>
      <div className="flex items-center gap-1">
        <div className="text-sm font-semibold text-white tabular-nums">{value}</div>
        {TrendIcon && <TrendIcon className={`w-3 h-3 ${trend === 'down' ? 'text-red-300' : 'text-emerald-300'}`} strokeWidth={2.25} />}
      </div>
    </div>
  );
}

function FilterChip({ active, label, count }) {
  return (
    <button
      className={`shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-medium transition-colors border ${
        active
          ? 'bg-slate-900 text-white border-slate-900'
          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:text-slate-900'
      }`}
    >
      {label}
      {count !== undefined && (
        <span className={`tabular-nums ${active ? 'text-white/70' : 'text-slate-400'}`}>{count}</span>
      )}
    </button>
  );
}

function Prediction({ rank, likelihood, likelihoodScore, category, headline, source, rebuttal, precedent, preEmpt }) {
  const [expanded, setExpanded] = useState(rank === 1);

  const tone = {
    High: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-900', tag: 'bg-red-100 text-red-700' },
    Medium: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-900', tag: 'bg-amber-100 text-amber-700' },
    Low: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-900', tag: 'bg-blue-100 text-blue-700' },
  }[likelihood] || {};

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      {/* Top: management response */}
      <button onClick={() => setExpanded(!expanded)} className="w-full text-left">
        <div className="px-4 lg:px-5 py-4 flex items-start gap-3">
          <div className={`w-8 h-8 rounded-full ${tone.tag} flex items-center justify-center shrink-0 text-xs font-mono font-bold tabular-nums`}>
            {rank}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${tone.tag} uppercase tracking-wide`}>
                {likelihood} likelihood
              </span>
              <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">{category}</span>
              <span className="text-[10px] font-mono text-slate-400 tabular-nums">{likelihoodScore}%</span>
            </div>
            <div className="text-base text-slate-900 italic leading-snug" style={{ fontFamily: 'Source Serif 4, Georgia, serif' }}>
              "{headline}"
            </div>
            <div className="text-[11px] text-slate-500 mt-1.5">{source}</div>
          </div>
          <ChevronDown className={`w-5 h-5 text-slate-400 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} strokeWidth={2} />
        </div>

        {/* Likelihood meter */}
        <div className="px-4 lg:px-5 pb-3">
          <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${likelihood === 'High' ? 'bg-red-500' : likelihood === 'Medium' ? 'bg-amber-500' : 'bg-blue-500'}`}
              style={{ width: `${likelihoodScore}%` }}
            />
          </div>
        </div>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-slate-200">
          {/* Rebuttal */}
          <div className="px-4 lg:px-5 py-4 lg:py-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-md bg-emerald-50 flex items-center justify-center">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-700" strokeWidth={2} />
              </div>
              <div className="text-xs font-semibold text-slate-900 uppercase tracking-wide">Rebuttal</div>
            </div>
            <ul className="space-y-2.5">
              {rebuttal.map((point, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="text-[10px] font-mono text-slate-400 mt-1.5 tabular-nums shrink-0">{i + 1}.</span>
                  <div className="text-[14px] text-slate-700 leading-relaxed" style={{ fontFamily: 'Source Serif 4, Georgia, serif' }}>
                    {point.text}
                    {point.citations && point.citations.length > 0 && (
                      <span className="ml-1.5 inline-flex flex-wrap gap-1" style={{ fontFamily: 'Inter, sans-serif' }}>
                        {point.citations.map((c) => (
                          <span key={c} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px] font-medium border border-slate-200">
                            {c.split('-')[0].toUpperCase()} {c.split('-').slice(1).join(' ')}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Precedent */}
          {precedent && (
            <div className="px-4 lg:px-5 py-4 bg-slate-50 border-t border-slate-200">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-md bg-blue-50 flex items-center justify-center shrink-0 mt-0.5">
                  <BookOpen className="w-3.5 h-3.5 text-blue-700" strokeWidth={2} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-semibold text-slate-700 uppercase tracking-wide mb-1">Precedent</div>
                  <div className="text-[13px] text-slate-700 leading-relaxed">{precedent}</div>
                  <button className="mt-2 text-[11px] font-medium text-slate-900 inline-flex items-center gap-1 hover:underline">
                    See the orders <ChevronRight className="w-3 h-3" strokeWidth={2.5} />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Pre-empt */}
          {preEmpt && (
            <div className="px-4 lg:px-5 py-4 bg-amber-50 border-t border-amber-100">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-md bg-amber-100 flex items-center justify-center shrink-0 mt-0.5">
                  <Zap className="w-3.5 h-3.5 text-amber-700" strokeWidth={2} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-semibold text-amber-900 uppercase tracking-wide mb-1">Pre-empt move</div>
                  <div className="text-[13px] text-amber-900 leading-relaxed">{preEmpt}</div>
                </div>
              </div>
            </div>
          )}

          {/* Action row */}
          <div className="px-4 lg:px-5 py-3 bg-white border-t border-slate-200 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button className="h-8 w-8 rounded-md hover:bg-slate-100 flex items-center justify-center text-slate-500" title="Save to talking points">
                <Bookmark className="w-4 h-4" strokeWidth={2} />
              </button>
              <button className="h-8 px-2.5 rounded-md hover:bg-slate-100 text-[11px] font-medium text-slate-600 inline-flex items-center gap-1">
                <Quote className="w-3 h-3" strokeWidth={2} />
                Copy rebuttal
              </button>
            </div>
            <div className="flex items-center gap-1">
              <button className="h-8 w-8 rounded-md hover:bg-emerald-50 hover:text-emerald-700 flex items-center justify-center text-slate-400 transition-colors" title="Useful prediction">
                <ThumbsUp className="w-4 h-4" strokeWidth={2} />
              </button>
              <button className="h-8 w-8 rounded-md hover:bg-red-50 hover:text-red-700 flex items-center justify-center text-slate-400 transition-colors" title="Not useful">
                <ThumbsDown className="w-4 h-4" strokeWidth={2} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
