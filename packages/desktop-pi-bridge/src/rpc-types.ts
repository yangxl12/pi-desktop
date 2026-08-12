import type { ThinkingLevel } from "@earendil-works/pi-desktop-protocol";

export type RpcCommand =
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_commands" }
	| { id?: string; type: "prompt"; message: string }
	| { id?: string; type: "steer"; message: string }
	| { id?: string; type: "follow_up"; message: string }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "get_available_thinking_levels" }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "set_session_name"; name: string };

export interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}
