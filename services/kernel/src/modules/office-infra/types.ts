/** A row of office_environments — one per office (flow). */
export interface OfficeEnvRow {
  flow_id: string;
  image: string;
  container_name: string;
  workspace_subpath: string;
  ports_json: string;
  env_json: string;
  network: string;
  run_command: string;
  desired_state: "stopped" | "running" | "paused";
  last_status: OfficeEnvState;
  last_status_at: string;
  last_error: string;
  created_at: string;
  updated_at: string;
}

/** Canonical observed state of the office container. */
export type OfficeEnvState =
  | "absent"   // no container exists
  | "created"  // created but never started
  | "running"
  | "paused"
  | "exited"   // stopped, restartable
  | "error";   // docker unreachable / inspect failed

/** What the API/tools return for a status query. */
export interface OfficeEnvStatus {
  flow_id: string;
  state: OfficeEnvState;
  image: string;
  container_name: string;
  preview_url: string | null;
  desired_state: OfficeEnvRow["desired_state"];
  last_error: string;
}

/** Result of one docker invocation. */
export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable docker runner — real impl uses spawnSync; tests pass a fake. */
export type DockerRunner = (args: string[]) => DockerResult;
