/**
 * Bounded real-model pilot.
 *
 * When a real provider credential is reachable from this environment, ask the
 * pinned model for the six fleet dispositions once, then run both arms against
 * those same answers, so the arms differ only in execution durability. Model
 * answers are retained verbatim and never fabricated: a missing credential or
 * any failed call is reported as a limitation rather than a result.
 *
 * The calls go through the pinned provider's own request path rather than the
 * durable conversation seam, because that seam does not carry the session
 * affinity header opencode-go requires; the report records that limitation.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Credential,
  type Models,
  type ModelsStoreEntry,
} from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { CandidateResult } from "../src/bridge.ts";
import { FLEET, type FleetTask } from "./fleet.ts";
import { runDurableScenario, runExistingScenario, truthfulResponder, type Responder } from "./runner.ts";

const PILOT_PROVIDER = "opencode-go";
const DEFAULT_PILOT_MODEL = "muse-spark-1.3-contributor";
const CALL_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_TOKENS = 2048;

export type PilotAnswer = {
  task: string;
  verdict: string;
  summary: string;
  text: string;
  latencyMs: number;
};

export type PilotResult = {
  status: "pass" | "fail" | "not-covered";
  reason?: string;
  provider?: string;
  model?: string;
  credentialSource?: string;
  catalogSource?: string | null;
  calls?: number;
  timeouts?: number;
  answers?: PilotAnswer[];
  matchingDispositions?: number;
  grades?: { existing: boolean; "pi-durable": boolean };
  latencyMs?: number;
};

type Discovery = {
  provider: string;
  model: string;
  credential: Credential;
  authSource: string;
  catalogSource: string | null;
  catalogEntry: ModelsStoreEntry | undefined;
};

/**
 * Locate a real api-key credential and the model catalog, without ever logging
 * the key. Only the provider id and the files used are reported.
 */
function discoverCredential(): Discovery | null {
  const authPath = process.env.FM_PI_DURABLE_AUTH_FILE ?? join(homedir(), ".pi", "agent", "auth.json");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const entry = parsed[PILOT_PROVIDER];
  if (!entry || typeof entry !== "object") return null;
  const candidate = entry as { type?: unknown; key?: unknown };
  if (candidate.type !== "api_key" || typeof candidate.key !== "string" || candidate.key.length === 0) {
    return null;
  }

  // The provider catalog is dynamic, so the registry needs the model catalog the
  // host already resolved; without it no model definition exists.
  const catalogPath =
    process.env.FM_PI_DURABLE_MODELS_STORE ?? join(homedir(), ".pi", "agent", "models-store.json");
  let catalogSource: string | null = null;
  let catalogEntry: ModelsStoreEntry | undefined;
  try {
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Record<
      string,
      ModelsStoreEntry | undefined
    >;
    catalogEntry = catalog[PILOT_PROVIDER];
    if (catalogEntry) catalogSource = catalogPath;
  } catch {
    catalogSource = null;
  }

  return {
    provider: PILOT_PROVIDER,
    model: process.env.FM_PI_DURABLE_PILOT_MODEL ?? DEFAULT_PILOT_MODEL,
    credential: candidate as Credential,
    authSource: authPath,
    catalogSource,
    catalogEntry,
  };
}

function pilotPrompt(task: FleetTask): string {
  return [
    "You are grading one supervised fleet task.",
    `Task id: ${task.id}`,
    `Title: ${task.title}`,
    `Observed state: ${task.planted}`,
    "Allowed dispositions: ready_for_review, surface_failure, working, escalate_decision, recover_or_escalate, preserve_state",
    "Allowed verdicts: routine, captain",
    `Reply with one JSON object only and no prose: {"task":"${task.id}","verdict":"routine"|"captain","summary":"disposition=<disposition>; <short reason>"}`,
  ].join("\n");
}

function answerText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => {
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string";
    })
    .map((block) => block.text)
    .join("\n")
    .trim();
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function buildRegistry(discovery: Discovery): Promise<{ models: Models; modelId: string }> {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(discovery.provider, async () => discovery.credential);
  const modelsStore = new InMemoryModelsStore();
  if (discovery.catalogEntry) {
    await modelsStore.write(discovery.provider, discovery.catalogEntry);
  }
  const models = createModels({ credentials, modelsStore });
  models.setProvider(opencodeGoProvider());
  return { models, modelId: discovery.model };
}

export async function runPilot(workDir: string, outcomeScript: string): Promise<PilotResult> {
  if (process.env.FM_PI_DURABLE_SKIP_PILOT) {
    return { status: "not-covered", reason: "the real-model pilot was skipped for this run" };
  }
  const discovery = discoverCredential();
  if (!discovery) {
    return {
      status: "not-covered",
      reason: `no api-key credential for ${PILOT_PROVIDER} is reachable from this environment`,
    };
  }
  if (!discovery.catalogEntry) {
    return {
      status: "not-covered",
      reason: `no model catalog for ${PILOT_PROVIDER} is reachable from this environment`,
      provider: discovery.provider,
      model: discovery.model,
      credentialSource: discovery.authSource,
      catalogSource: discovery.catalogSource,
    };
  }

  const startedAt = Date.now();
  const { models, modelId } = await buildRegistry(discovery);
  const model = models.getModel(discovery.provider, modelId);
  if (!model) {
    return {
      status: "fail",
      reason: `the pinned model ${modelId} is not in the ${discovery.provider} catalog`,
      provider: discovery.provider,
      model: modelId,
      credentialSource: discovery.authSource,
      catalogSource: discovery.catalogSource,
    };
  }

  const answers: PilotAnswer[] = [];
  let timeouts = 0;
  let failure: string | undefined;
  for (const task of FLEET) {
    const callStartedAt = Date.now();
    const settled = await withTimeout(
      models.completeSimple(
        model,
        {
          messages: [{ role: "user", content: pilotPrompt(task), timestamp: Date.now() }],
        },
        {
          sessionId: `fm-pi-durable-pilot-${task.id}`,
          maxTokens: MAX_OUTPUT_TOKENS,
          reasoning: "minimal",
        },
      ),
      CALL_TIMEOUT_MS,
    );
    if (settled === "timeout") {
      timeouts += 1;
      failure = `the model call for ${task.id} exceeded ${CALL_TIMEOUT_MS} ms`;
      break;
    }
    const text = answerText(settled.content);
    if (settled.stopReason === "error" || text.length === 0) {
      failure = `the model call for ${task.id} failed: ${settled.errorMessage ?? settled.stopReason}`;
      break;
    }
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    let parsed: { task?: unknown; verdict?: unknown; summary?: unknown };
    try {
      parsed = JSON.parse(json) as { task?: unknown; verdict?: unknown; summary?: unknown };
    } catch {
      failure = `the model answer for ${task.id} was not JSON: ${text.slice(0, 120)}`;
      break;
    }
    if (
      typeof parsed.task !== "string" ||
      typeof parsed.verdict !== "string" ||
      typeof parsed.summary !== "string"
    ) {
      failure = `the model answer for ${task.id} was not a candidate result: ${text.slice(0, 120)}`;
      break;
    }
    answers.push({
      task: parsed.task,
      verdict: parsed.verdict,
      summary: parsed.summary,
      text,
      latencyMs: Date.now() - callStartedAt,
    });
  }

  const base = {
    provider: discovery.provider,
    model: modelId,
    credentialSource: discovery.authSource,
    catalogSource: discovery.catalogSource,
    calls: answers.length,
    timeouts,
    answers,
    latencyMs: Date.now() - startedAt,
  };

  if (failure !== undefined || answers.length !== FLEET.length) {
    return { status: "fail", reason: failure ?? "the pilot did not collect one answer per task", ...base };
  }

  const byTask = new Map(answers.map((answer) => [answer.task, answer]));
  const responder: Responder = (task) => {
    const answer = byTask.get(task.id);
    if (!answer) return truthfulResponder()(task);
    return {
      task: task.id,
      verdict: answer.verdict === "captain" ? "captain" : "routine",
      summary: answer.summary,
    } satisfies CandidateResult;
  };

  const existing = await runExistingScenario({
    home: join(workDir, "pilot-arm-existing"),
    scenario: "pilot-fleet",
    tasks: FLEET,
    outcomeScript,
    respond: responder,
  });
  const durable = await runDurableScenario({
    home: join(workDir, "pilot-arm-durable"),
    scenario: "pilot-fleet",
    tasks: FLEET,
    outcomeScript,
    respond: responder,
  });

  const matchingDispositions = FLEET.filter((task) => {
    const answer = byTask.get(task.id);
    return answer !== undefined && answer.summary.includes(`disposition=${task.requiredDisposition}`);
  }).length;

  return {
    status: "pass",
    ...base,
    matchingDispositions,
    grades: {
      existing: existing.trace.outcomes.length === FLEET.length,
      "pi-durable": durable.trace.outcomes.length === FLEET.length,
    },
  };
}
