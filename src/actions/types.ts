/**
 * Action Types for LLM-driven routing
 *
 * The LLM outputs structured action blocks in its response.
 * daemon.ts parses these and executes the appropriate handler.
 */

// All action types the LLM can trigger
export type ActionType =
  | 'create_reminder'
  | 'list_reminders'
  | 'cancel_reminder'
  | 'create_schedule'
  | 'list_schedules'
  | 'cancel_schedule'
  | 'create_coding_task'
  | 'create_agentic_schedule'
  | 'test_agentic_workflow'
  | 'list_sessions'
  | 'search_sessions'
  | 'resume_session'
  | 'new_session'
  | 'show_status'
  | 'show_github_status'
  | 'set_model'
  | 'show_model'
  | 'route_to_machine'
  | 'list_machines';

// Action payloads
export interface CreateReminderAction {
  action: 'create_reminder';
  message: string;
  schedule: string; // natural language time like "tomorrow 9am EST"
}

export interface ListRemindersAction {
  action: 'list_reminders';
}

export interface CancelReminderAction {
  action: 'cancel_reminder';
  id: string;
}

export interface CreateScheduleAction {
  action: 'create_schedule';
  message: string;
  schedule: string; // natural language schedule like "every Monday 9am EST"
}

export interface ListSchedulesAction {
  action: 'list_schedules';
}

export interface CancelScheduleAction {
  action: 'cancel_schedule';
  id: string;
}

export interface CreateCodingTaskAction {
  action: 'create_coding_task';
  description: string;
  repo?: string; // "owner/repo" — LLM asks user if not provided
}

export interface CreateAgenticScheduleAction {
  action: 'create_agentic_schedule';
  name: string;
  description: string;
  schedule: string; // natural language cron
}

export interface TestAgenticWorkflowAction {
  action: 'test_agentic_workflow';
  name: string; // workflow name to test run
}

export interface ListSessionsAction {
  action: 'list_sessions';
  query?: string; // search term, or undefined for recent
  hours?: number; // for active sessions filter
}

export interface SearchSessionsAction {
  action: 'search_sessions';
  query: string;
}

export interface ResumeSessionAction {
  action: 'resume_session';
  session_id: string; // full or partial ID
}

export interface NewSessionAction {
  action: 'new_session';
}

export interface ShowStatusAction {
  action: 'show_status';
}

export interface ShowGithubStatusAction {
  action: 'show_github_status';
}

export interface SetModelAction {
  action: 'set_model';
  model: string;  // e.g. "claude-sonnet-4.5", "claude-opus-4.5", "gpt-4o"
}

export interface ShowModelAction {
  action: 'show_model';
}

export interface RouteToMachineAction {
  action: 'route_to_machine';
  machine_name: string;  // human-readable name or partial match
}

export interface ListMachinesAction {
  action: 'list_machines';
}

// Union of all action types
export type GhclawAction =
  | CreateReminderAction
  | ListRemindersAction
  | CancelReminderAction
  | CreateScheduleAction
  | ListSchedulesAction
  | CancelScheduleAction
  | CreateCodingTaskAction
  | CreateAgenticScheduleAction
  | TestAgenticWorkflowAction
  | ListSessionsAction
  | SearchSessionsAction
  | ResumeSessionAction
  | NewSessionAction
  | ShowStatusAction
  | ShowGithubStatusAction
  | SetModelAction
  | ShowModelAction
  | RouteToMachineAction
  | ListMachinesAction;

// Result from executing an action
export interface ActionResult {
  response: string;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  // Session management
  switchToSession?: string;
  pendingSessions?: any[]; // ChronicleSession[] — stored for number-based selection
}
