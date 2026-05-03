import { useState, useCallback, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Leaf, Upload, CheckCircle2, Loader2, Zap, Tv, Lightbulb, Smartphone, TrendingUp, ExternalLink } from "lucide-react";
import { MdvEngine, Scores } from "@/components/MdvEngine";
import QRCode from "qrcode";

const WH_PER_TOKEN = 0.0003;
const S_WEIGHT = 0.6;
const I_WEIGHT = 0.4;
const KETTLE_BOIL_WH = 0.025;
const LED_WH_PER_MIN = 0.01;
const PHONE_BATTERY_WH = 12;
const STREAM_WH_PER_SEC = 0.001;

const DAILY_SESSIONS = 10;
const DAYS_30 = 30;
const DAYS_365 = 365;
const UK_AI_USERS = 1_000_000;
const UK_HOUSEHOLD_KWH = 3500;

function computeEnergy(T: number, S: number, I: number): number {
  const baseWh = T * WH_PER_TOKEN;
  const complexityMult = 1 + S * S_WEIGHT + I * I_WEIGHT;
  return baseWh * complexityMult;
}

function getEnergyColor(energyWh: number): string {
  if (energyWh < 0.0005) return "text-green-500";
  if (energyWh < 0.002) return "text-amber-500";
  return "text-red-500";
}

function getScoreColor(score: number, dim: "T" | "S" | "I"): string {
  const thresholds = { T: [0.4, 0.75], S: [0.35, 0.7], I: [0.4, 0.75] };
  const [lo, hi] = thresholds[dim];
  if (score < lo) return "text-green-500";
  if (score < hi) return "text-amber-500";
  return "text-red-500";
}

function getScoreLabel(score: number, dim: "T" | "S" | "I"): string {
  const thresholds = { T: [0.4, 0.75], S: [0.35, 0.7], I: [0.4, 0.75] };
  const [lo, hi] = thresholds[dim];
  if (score < lo) return "Efficient";
  if (score < hi) return "Moderate";
  return "High";
}

function sig2(n: number): string {
  if (n < 0.001) return "< 0.001";
  return parseFloat(n.toPrecision(2)).toString();
}

function fmtWh(wh: number): string {
  if (wh >= 1000) return `${sig2(wh / 1000)} kWh`;
  if (wh >= 1) return `${sig2(wh)} Wh`;
  return `${sig2(wh * 1000)} mWh`;
}

function computeTranslations(energyWh: number) {
  const kettleBoils = energyWh / KETTLE_BOIL_WH;
  const kettleSeconds = kettleBoils * 120;
  const streamingSeconds = energyWh / STREAM_WH_PER_SEC;
  const streamingMinutes = streamingSeconds / 60;
  const ledMinutes = energyWh / LED_WH_PER_MIN;
  const ledHours = ledMinutes / 60;
  const phoneChargePct = (energyWh / PHONE_BATTERY_WH) * 100;

  return [
    {
      icon: Zap,
      label: "Kettle boil",
      value: kettleBoils < 0.1 ? `${sig2(kettleSeconds)}s` : `${sig2(kettleBoils)}×`,
      sentence: kettleBoils < 0.1
        ? `About ${sig2(kettleSeconds)} seconds of boiling your kettle.`
        : `As much energy as ${sig2(kettleBoils)} kettle boils.`,
      color: kettleBoils < 0.04 ? "text-green-500" : kettleBoils < 0.16 ? "text-amber-500" : "text-red-500",
    },
    {
      icon: Tv,
      label: "HD streaming",
      value: streamingSeconds < 60 ? `${sig2(streamingSeconds)}s` : `${sig2(streamingMinutes)} min`,
      sentence: streamingSeconds < 60
        ? `Equivalent to streaming about ${sig2(streamingSeconds)} seconds of HD video.`
        : `Equivalent to about ${sig2(streamingMinutes)} minutes of HD video streaming.`,
      color: streamingSeconds < 0.5 ? "text-green-500" : streamingSeconds < 2.0 ? "text-amber-500" : "text-red-500",
    },
    {
      icon: Lightbulb,
      label: "LED bulb",
      value: ledMinutes < 60 ? `${sig2(ledMinutes)} min` : `${sig2(ledHours)} hrs`,
      sentence: ledMinutes < 60
        ? `Enough energy to power a light bulb for ${sig2(ledMinutes)} minutes.`
        : `Enough energy to power a light bulb for ${sig2(ledHours)} hours.`,
      color: ledMinutes < 0.05 ? "text-green-500" : ledMinutes < 0.2 ? "text-amber-500" : "text-red-500",
    },
    {
      icon: Smartphone,
      label: "Phone charge",
      value: `${sig2(phoneChargePct)}%`,
      sentence: `About ${sig2(phoneChargePct)}% of a single phone charge.`,
      color: phoneChargePct < 0.005 ? "text-green-500" : phoneChargePct < 0.02 ? "text-amber-500" : "text-red-500",
    },
  ];
}

function computeProjections(energyWh: number) {
  const daily = energyWh * DAILY_SESSIONS;
  const monthly = daily * DAYS_30;
  const yearly = daily * DAYS_365;
  const monthlyKettles = monthly / KETTLE_BOIL_WH;
  const yearlyKettles = yearly / KETTLE_BOIL_WH;
  const ukMonthlyWh = monthly * UK_AI_USERS;
  const ukYearlyKWh = (yearly * UK_AI_USERS) / 1000;
  const householdsEquivalent = Math.round(ukYearlyKWh / UK_HOUSEHOLD_KWH);

  return { daily, monthly, yearly, monthlyKettles, yearlyKettles, ukMonthlyWh, ukYearlyKWh, householdsEquivalent };
}

const SCORE_CARDS: { key: keyof Scores; letter: string; name: string; dim: "T" | "S" | "I" }[] = [
  { key: "tokenRatio", letter: "T", name: "Token Ratio", dim: "T" },
  { key: "structuralScore", letter: "S", name: "Structural Weight", dim: "S" },
  { key: "intentRatio", letter: "I", name: "Intent Weight", dim: "I" },
];

const LOADING_STEPS = ["Booting engine", "Installing dependencies", "Starting server", "Analysing prompt"];

function ScoreGauge({ score, color }: { score: number; color: string }) {
  const circumference = 2 * Math.PI * 36;
  const offset = circumference - score * circumference;
  const strokeColor =
    color === "text-green-500" ? "#22c55e" :
    color === "text-amber-500" ? "#f59e0b" : "#ef4444";

  return (
    <div className="relative flex items-center justify-center my-4">
      <svg width="96" height="96" className="-rotate-90">
        <circle cx="48" cy="48" r="36" fill="none" stroke="currentColor" strokeWidth="6" className="text-muted/30" />
        <circle
          cx="48" cy="48" r="36" fill="none"
          stroke={strokeColor} strokeWidth="6"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 1s ease" }}
        />
      </svg>
      <span className={`absolute text-2xl font-mono font-bold ${color}`}>
        {score.toFixed(2)}
      </span>
    </div>
  );
}

export default function Home() {
  const [uploadedJson, setUploadedJson] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [scores, setScores] = useState<Scores | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const [suggestions, setSuggestions] = useState<Array<{original: string, alternative: string | null, tokenSaving: number}> | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  useEffect(() => {
    if (!portalUrl || !qrCanvasRef.current) return;
    QRCode.toCanvas(qrCanvasRef.current, portalUrl, {
      width: 160,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    });
  }, [portalUrl]);

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith(".json")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setUploadedJson(e.target?.result as string);
      setFileName(file.name);
      setScores(null);
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleStatusChange = useCallback((status: string) => {
    if (status === "booting") setLoadingStep(0);
    if (status === "installing") setLoadingStep(1);
    if (status === "starting") setLoadingStep(2);
    if (status === "analyzing") setLoadingStep(3);
    if (status === "ready") setIsReady(true);
  }, []);

  const handleSuggest = useCallback(async () => {
    if (!portalUrl) return;
    setSuggestionsLoading(true);
    setSuggestions(null);
    try {
      const resp = await fetch(`${portalUrl}/suggest`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setSuggestions(data);
    } catch (e: any) {
      setSuggestions([]);
    } finally {
      setSuggestionsLoading(false);
    }
  }, [portalUrl]);

  const handleScores = useCallback((s: Scores) => {
    setScores(s);
    setIsReady(true);
  }, []);

  const energyWh = scores
    ? computeEnergy(scores.tokenRatio, scores.structuralScore, scores.intentRatio)
    : null;
  const translations = energyWh !== null ? computeTranslations(energyWh) : null;
  const projections = energyWh !== null ? computeProjections(energyWh) : null;

  return (
    <div className="min-h-screen w-full bg-background text-foreground font-sans flex flex-col items-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-4xl space-y-8">

        <header className="text-center space-y-3">
          <div className="inline-flex items-center justify-center p-3 rounded-2xl bg-primary/10 mb-2">
            <Leaf className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-4xl font-serif font-bold text-foreground">
            Prompt Sustainability Analyzer
          </h1>
          <p className="text-muted-foreground max-w-2xl mx-auto text-lg">
            Measure the environmental footprint of your LLM prompts. Optimize for clarity,
            reduce tokens, and minimize energy consumption.
          </p>
        </header>

        <Card className="border-border shadow-sm bg-card/50 backdrop-blur">
          <CardContent className="pt-6">
            <div
              className={`border-2 border-dashed rounded-lg p-10 text-center transition-colors cursor-pointer ${
                dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
            >
              <Upload className="w-8 h-8 mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm text-muted-foreground mb-1">
                Drag &amp; drop a JSON prompt file, or{" "}
                <label className="text-primary cursor-pointer hover:underline">
                  browse
                  <input type="file" accept=".json" className="sr-only" onChange={handleChange} />
                </label>
              </p>
              <p className="text-xs text-muted-foreground">Accepts .json files only</p>
              {fileName && (
                <p className="mt-4 text-sm font-mono text-foreground bg-muted px-3 py-1 rounded-md inline-block">
                  {fileName}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {uploadedJson && (
          <Card className="border-border shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Prompt preview
              </CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-xs font-mono text-foreground bg-muted rounded-md p-4 overflow-auto max-h-48 whitespace-pre-wrap">
                {uploadedJson}
              </pre>
            </CardContent>
          </Card>
        )}

        {!isReady && (
          <Card className="border-border shadow-sm bg-card/50">
            <CardContent className="pt-6 pb-6">
              <div className="space-y-3">
                {LOADING_STEPS.map((step, i) => (
                  <div key={step} className="flex items-center gap-3">
                    {i < loadingStep ? (
                      <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                    ) : i === loadingStep ? (
                      <Loader2 className="w-4 h-4 text-primary shrink-0 animate-spin" />
                    ) : (
                      <div className="w-4 h-4 rounded-full border border-muted-foreground/30 shrink-0" />
                    )}
                    <span className={`text-sm ${i <= loadingStep ? "text-foreground" : "text-muted-foreground"}`}>
                      {step}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <MdvEngine
          uploadedJson={uploadedJson}
          onScores={handleScores}
          onStatusChange={handleStatusChange}
          onPortalUrl={setPortalUrl}
        />

        {portalUrl && (
          <Card className="border-primary/30 bg-primary/5" style={{ animation: "fadeUp 0.4s ease both" }}>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-start gap-4">
                <canvas ref={qrCanvasRef} className="rounded-md shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 rounded-full bg-primary animate-pulse shrink-0" />
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">
                      Judge view — scan or open on any device
                    </p>
                  </div>
                  <p className="text-xs font-mono text-primary break-all leading-relaxed">{portalUrl}</p>
                  <a
                    href={portalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 mt-2 text-xs text-primary hover:underline"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Open in new tab
                  </a>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {scores && energyWh !== null && translations !== null && projections !== null && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {SCORE_CARDS.map(({ key, letter, name, dim }, i) => {
                const color = getScoreColor(scores[key], dim);
                return (
                  <Card
                    key={key}
                    className="border-border shadow-sm"
                    style={{ animation: `fadeUp 0.4s ease both`, animationDelay: `${i * 0.12}s` }}
                  >
                    <CardHeader className="pb-0">
                      <CardTitle className="flex items-center gap-2">
                        <span className="text-2xl font-bold font-mono text-primary">{letter}</span>
                        <span className="text-sm font-normal text-muted-foreground">{name}</span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ScoreGauge score={scores[key]} color={color} />
                      <p className={`text-sm font-medium text-center ${color}`}>
                        {getScoreLabel(scores[key], dim)}
                      </p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            <Card className="border-border shadow-sm" style={{ animation: "fadeUp 0.4s ease both", animationDelay: "0.4s" }}>
              <CardHeader className="pb-3 border-b">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Leaf className="w-4 h-4 text-primary" />
                  Environmental impact
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                <div className="grid grid-cols-2 gap-4">
                  {translations.map(({ icon: Icon, label, value, sentence, color }) => (
                    <div key={label} className="flex items-start gap-3 p-3 rounded-lg bg-muted/40">
                      <Icon className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
                        <p className={`text-xl font-mono font-bold ${color}`}>{value}</p>
                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{sentence}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="border-border shadow-sm" style={{ animation: "fadeUp 0.4s ease both", animationDelay: "0.52s" }}>
              <CardHeader className="pb-3 border-b">
                <CardTitle className="flex items-center gap-2 text-base">
                  <TrendingUp className="w-4 h-4 text-primary" />
                  Usage projection
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  Based on {DAILY_SESSIONS} sessions per day at this conversation's intensity
                </p>
              </CardHeader>
              <CardContent className="pt-4 space-y-4">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">Your footprint</p>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="p-3 rounded-lg bg-muted/40 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Per day</p>
                      <p className="text-lg font-mono font-bold text-foreground">{fmtWh(projections.daily)}</p>
                      <p className="text-xs text-muted-foreground mt-1">{sig2(projections.daily / KETTLE_BOIL_WH)} kettle boils</p>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/40 text-center">
                      <p className="text-xs text-muted-foreground mb-1">30 days</p>
                      <p className="text-lg font-mono font-bold text-foreground">{fmtWh(projections.monthly)}</p>
                      <p className="text-xs text-muted-foreground mt-1">{sig2(projections.monthlyKettles)} kettle boils</p>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/40 text-center">
                      <p className="text-xs text-muted-foreground mb-1">1 year</p>
                      <p className="text-lg font-mono font-bold text-foreground">{fmtWh(projections.yearly)}</p>
                      <p className="text-xs text-muted-foreground mt-1">{sig2(projections.yearlyKettles)} kettle boils</p>
                    </div>
                  </div>
                </div>
                <div className="border-t pt-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">
                    At scale — 1 million UK AI users prompting this way
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 rounded-lg bg-muted/40">
                      <p className="text-xs text-muted-foreground mb-1">Monthly collective</p>
                      <p className="text-lg font-mono font-bold text-foreground">{fmtWh(projections.ukMonthlyWh)}</p>
                      <p className="text-xs text-muted-foreground mt-1">across all users per month</p>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/40">
                      <p className="text-xs text-muted-foreground mb-1">Annual equivalent</p>
                      <p className="text-lg font-mono font-bold text-foreground">{projections.householdsEquivalent.toLocaleString()} homes</p>
                      <p className="text-xs text-muted-foreground mt-1">UK households powered for a year</p>
                    </div>
                  </div>
                </div>
                <div className="border-t pt-4">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Reducing average prompt complexity by 30% across 1 million users would save the equivalent of{" "}
                    <span className="text-foreground font-medium">
                      {Math.round(projections.householdsEquivalent * 0.3).toLocaleString()} UK homes
                    </span>{" "}
                    worth of annual energy. Small habits, scaled, matter.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border shadow-sm" style={{ animation: "fadeUp 0.4s ease both", animationDelay: "0.6s" }}>
              <CardHeader className="pb-3 border-b">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Leaf className="w-4 h-4 text-primary" />
                  Phrase efficiency suggestions
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  Identifies the 5 longest sentences and suggests tighter alternatives
                </p>
              </CardHeader>
              <CardContent className="pt-4">
                {!suggestions && !suggestionsLoading && (
                  <button
                    onClick={handleSuggest}
                    className="w-full py-2 px-4 rounded-lg bg-primary/10 border border-primary/30 text-primary text-sm font-medium hover:bg-primary/20 transition-colors"
                  >
                    Analyse phrase efficiency
                  </button>
                )}
                {suggestionsLoading && (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm py-2">
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                    Analysing top 5 sentences — this may take 15–20 seconds...
                  </div>
                )}
                {suggestions && suggestions.length === 0 && (
                  <p className="text-sm text-muted-foreground">No unambiguous inefficiencies found. This prompt is well-written.</p>
                )}
                {suggestions && suggestions.length > 0 && (
                  <div className="space-y-5">
                    {suggestions.map((s: any, i: number) => (
                      <div key={i} className="space-y-3">
                        <p className="text-xs text-muted-foreground leading-relaxed border-l-2 border-border pl-3">
                          {(() => {
                            let sentence = s.sentence;
                            const phrases = s.findings.map((f: any) => f.phrase);
                            const parts: React.ReactNode[] = [];
                            let remaining = sentence;
                            let key = 0;

                            while (remaining.length > 0) {
                              let earliestIndex = -1;
                              let earliestPhrase = '';

                              for (const phrase of phrases) {
                                const idx = remaining.toLowerCase().indexOf(phrase.toLowerCase());
                                if (idx !== -1 && (earliestIndex === -1 || idx < earliestIndex)) {
                                  earliestIndex = idx;
                                  earliestPhrase = phrase;
                                }
                              }

                              if (earliestIndex === -1) {
                                parts.push(<span key={key++}>{remaining}</span>);
                                break;
                              }

                              if (earliestIndex > 0) {
                                parts.push(<span key={key++}>{remaining.slice(0, earliestIndex)}</span>);
                              }

                              parts.push(
                                <mark key={key++} className="bg-amber-500/20 text-amber-400 rounded px-0.5 not-italic font-medium">
                                  {remaining.slice(earliestIndex, earliestIndex + earliestPhrase.length)}
                                </mark>
                              );

                              remaining = remaining.slice(earliestIndex + earliestPhrase.length);
                            }

                            return parts;
                          })()}
                        </p>
                        <div className="space-y-2">
                          {s.findings.map((f: any, j: number) => (
                            <div key={j} className="flex items-start gap-3 p-2 rounded-lg bg-muted/40">
                              <span className="text-xs font-mono bg-primary/10 text-primary px-2 py-0.5 rounded shrink-0 mt-0.5">
                                {f.category === 'filler' ? 'filler' : f.category === 'padding' ? 'padding' : 'redundant'}
                              </span>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-foreground">
                                  "{f.phrase}"
                                  {f.suggestion && (
                                    <span className="text-muted-foreground font-normal"> → </span>
                                  )}
                                  {f.suggestion && (
                                    <span className="text-primary font-medium">"{f.suggestion}"</span>
                                  )}
                                  {!f.suggestion && (
                                    <span className="text-muted-foreground font-normal"> → remove</span>
                                  )}
                                </p>
                                <p className="text-xs text-muted-foreground mt-0.5">{f.reason}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-primary/20 bg-primary/5" style={{ animation: "fadeUp 0.4s ease both", animationDelay: "0.64s" }}>
              <CardContent className="pt-6 pb-6">
                <div className="flex items-start gap-3">
                  <Leaf className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                  <p className={`text-sm leading-relaxed font-medium ${getEnergyColor(energyWh)}`}>
                    Total estimated energy: {energyWh.toPrecision(2)} Wh —{" "}
                    {energyWh < 0.0005
                      ? "negligible footprint. This conversation is highly efficient."
                      : energyWh < 0.002
                      ? "modest footprint. Consider simplifying structure or intent for repeated use."
                      : "notable footprint. Prompt redesign could meaningfully reduce energy cost."}
                  </p>
                </div>
              </CardContent>
            </Card>
          </>
        )}

      </div>

      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
