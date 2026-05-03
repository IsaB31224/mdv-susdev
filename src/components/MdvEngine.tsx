import { useEffect, useRef, useState } from "react";
import { BrowserPod } from "@leaningtech/browserpod";

export interface Scores {
  tokenRatio: number;
  intentRatio: number;
  structuralScore: number;
}

interface MdvEngineProps {
  uploadedJson: string | null;
  onScores: (scores: Scores) => void;
  onStatusChange?: (status: string) => void;
  onPortalUrl?: (url: string) => void;
}

type Status = "booting" | "ready" | "analyzing" | "error";

async function copyFileToPod(pod: any, publicPath: string, podBasePath: string) {
  const normalizedBase = podBasePath.endsWith("/") ? podBasePath.slice(0, -1) : podBasePath;
  const resp = await fetch(publicPath);
  const text = await resp.text();
  const f = await pod.createFile(`${normalizedBase}/${publicPath}`, "utf-8");
  await f.write(text);
  await f.close();
}

export function MdvEngine({ uploadedJson, onScores, onStatusChange, onPortalUrl }: MdvEngineProps) {
  const [status, setStatus] = useState<Status>("booting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const podRef = useRef<any>(null);
  const portalUrlRef = useRef<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const terminalRef = useRef<HTMLPreElement>(null);

  const scoredJsonRef = useRef<string | null>(null);
  const onScoresRef = useRef(onScores);
  const onStatusChangeRef = useRef(onStatusChange);
  const onPortalUrlRef = useRef(onPortalUrl);
  useEffect(() => { onScoresRef.current = onScores; }, [onScores]);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);
  useEffect(() => { onPortalUrlRef.current = onPortalUrl; }, [onPortalUrl]);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        onStatusChangeRef.current?.("booting");

        const pod = await BrowserPod.boot({ apiKey: import.meta.env.VITE_BP_APIKEY });
        if (cancelled) return;
        podRef.current = pod;

        const terminal = await pod.createDefaultTerminal(terminalRef.current);

        const homePath = "/home/user";
        const projectPath = `${homePath}/project`;
        await pod.createDirectory(projectPath);

        await copyFileToPod(pod, "project/main.js", homePath);
        await copyFileToPod(pod, "project/package.json", homePath);
        await copyFileToPod(pod, "project/prompt_data_example.json", homePath);

        const configFile = await pod.createFile(`${projectPath}/.env`, "utf-8");
        await configFile.write(`ANTHROPIC_API_KEY=${import.meta.env.VITE_ANTHROPIC_API_KEY}`);
        await configFile.close();

        pod.onPortal(({ url }: { url: string; port: number }) => {
          if (cancelled) return;
          portalUrlRef.current = url;
          console.log("Portal URL:", url);
          setPortalUrl(url);
          setStatus("ready");
          onStatusChangeRef.current?.("ready");
          onPortalUrlRef.current?.(url);
        });

        onStatusChangeRef.current?.("installing");
        await pod.run("npm", ["install"], { echo: true, terminal, cwd: projectPath });

        onStatusChangeRef.current?.("starting");
        try {
          await pod.run("node", ["main.js"], {
            echo: true,
            terminal,
            cwd: projectPath,
          });
        } catch (err: any) {
          if (!cancelled) {
            setStatus("error");
            setErrorMsg(err.message);
          }
        }

      } catch (err: any) {
        if (!cancelled) {
          setStatus("error");
          setErrorMsg(err.message || "Failed to boot pod");
        }
      }
    }

    boot();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!uploadedJson || !portalUrl || !podRef.current) return;
    if (scoredJsonRef.current === uploadedJson) return;
    scoredJsonRef.current = uploadedJson;

    let cancelled = false;

    async function analyze() {
      setStatus("analyzing");
      onStatusChangeRef.current?.("analyzing");
      try {
        const pod = podRef.current;

        const f = await pod.createFile("/home/user/project/prompt_data.json", "utf-8");
        await f.write(uploadedJson!);
        await f.close();

        const resp = await fetch(`${portalUrl}/analyze`);
        if (!resp.ok) {
          const body = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${body}`);
        }
        const data: Scores = await resp.json();

        if (!cancelled) {
          onScoresRef.current(data);
          setStatus("ready");
          onStatusChangeRef.current?.("ready");
        }
      } catch (err: any) {
        if (!cancelled) {
          setStatus("error");
          setErrorMsg(err.message || "Analysis failed - portal: " + portalUrl);
        }
      }
    }

    analyze();
    return () => { cancelled = true; };
  }, [uploadedJson, portalUrl]);

  if (status === "error") {
    return (
      <div className="text-center text-destructive py-6 text-sm">
        <pre ref={terminalRef} style={{ display: "none" }} />
        Engine error: {errorMsg}
      </div>
    );
  }

  return <pre ref={terminalRef} style={{ display: "none" }} />;
}