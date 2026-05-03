import { BrowserPod } from '@leaningtech/browserpod'
import { copyFile } from './utils'

const pod = await BrowserPod.boot({apiKey:import.meta.env.VITE_BP_APIKEY});

const terminal = await pod.createDefaultTerminal(document.querySelector("#console"));

const portalIframe = document.getElementById("portal");
const urlDiv = document.getElementById("url");
pod.onPortal(({ url, port }) => {
  urlDiv.innerHTML = `Portal available at <a href="${url}">${url}</a> for local server listening on port ${port}`;
  portalIframe.src = url;
});

const homePath = "/home/user";
const projectPath = `${homePath}/project`;
await pod.createDirectory(projectPath);
await copyFile(pod, "project/main.js", homePath);
await copyFile(pod, "project/package.json", homePath);
await copyFile(pod, "project/prompt_data_example.json", homePath);

const configFile = await pod.createFile(`${projectPath}/.env`, "utf-8");
await configFile.write(`ANTHROPIC_API_KEY=${import.meta.env.VITE_ANTHROPIC_API_KEY}`);
await configFile.close();

await pod.run("npm", ["install"], {echo:true, terminal:terminal, cwd: projectPath});
await pod.run("node", ["main.js"], {echo:true, terminal:terminal, cwd: projectPath});