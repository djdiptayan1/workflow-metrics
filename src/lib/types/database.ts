export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
	public: {
		Tables: {
			github_connections: {
				Row: {
					id: string;
					user_id: string;
					github_user_id: number;
					github_username: string;
					avatar_url: string | null;
					access_token: string;
					scopes: string[] | null;
					created_at: string;
					updated_at: string;
				};
				Insert: {
					id?: string;
					user_id: string;
					github_user_id: number;
					github_username: string;
					avatar_url?: string | null;
					access_token: string;
					scopes?: string[] | null;
					created_at?: string;
					updated_at?: string;
				};
				Update: {
					id?: string;
					user_id?: string;
					github_user_id?: number;
					github_username?: string;
					avatar_url?: string | null;
					access_token?: string;
					scopes?: string[] | null;
					updated_at?: string;
				};
			};
			repositories: {
				Row: {
					id: string;
					user_id: string;
					connection_id: string;
					github_repo_id: number;
					owner: string;
					name: string;
					full_name: string;
					is_private: boolean;
					is_active: boolean;
					created_at: string;
				};
				Insert: {
					id?: string;
					user_id: string;
					connection_id: string;
					github_repo_id: number;
					owner: string;
					name: string;
					full_name: string;
					is_private?: boolean;
					is_active?: boolean;
					created_at?: string;
				};
				Update: {
					id?: string;
					is_active?: boolean;
				};
			};
			user_settings: {
				Row: {
					id: string;
					user_id: string;
					mistral_api_key: string | null;
					ai_provider: 'openai' | 'gemini' | 'mistral';
					ai_api_key: string | null;
					ai_model: string | null;
					theme: 'dark' | 'light' | 'system';
					default_repo_id: string | null;
					actions_lookback: '7' | '30' | '90' | 'all';
					dashboard_refresh_interval: 'realtime' | '5' | '10' | '15';
					created_at: string;
					updated_at: string;
				};
				Insert: {
					id?: string;
					user_id: string;
					mistral_api_key?: string | null;
					ai_provider?: 'openai' | 'gemini' | 'mistral';
					ai_api_key?: string | null;
					ai_model?: string | null;
					theme?: 'dark' | 'light' | 'system';
					default_repo_id?: string | null;
					actions_lookback?: '7' | '30' | '90' | 'all';
					dashboard_refresh_interval?: 'realtime' | '5' | '10' | '15';
					created_at?: string;
					updated_at?: string;
				};
				Update: {
					mistral_api_key?: string | null;
					ai_provider?: 'openai' | 'gemini' | 'mistral';
					ai_api_key?: string | null;
					ai_model?: string | null;
					theme?: 'dark' | 'light' | 'system';
					default_repo_id?: string | null;
					actions_lookback?: '7' | '30' | '90' | 'all';
					dashboard_refresh_interval?: 'realtime' | '5' | '10' | '15';
					updated_at?: string;
				};
			};
			dora_workflows: {
				Row: {
					id: string;
					user_id: string;
					repository_id: string;
					workflow_id: number;
					workflow_name: string;
					workflow_path: string;
					created_at: string;
				};
				Insert: {
					id?: string;
					user_id: string;
					repository_id: string;
					workflow_id: number;
					workflow_name: string;
					workflow_path: string;
					created_at?: string;
				};
				Update: {
					workflow_name?: string;
					workflow_path?: string;
				};
			};
			repository_workflow_settings: {
				Row: { github_repo_id: number; preferences_mode: 'personal' | 'shared'; updated_by: string | null; updated_at: string };
				Insert: { github_repo_id: number; preferences_mode?: 'personal' | 'shared'; updated_by?: string | null; updated_at?: string };
				Update: { preferences_mode?: 'personal' | 'shared'; updated_by?: string | null; updated_at?: string };
				Relationships: [];
			};
			workflow_preferences: {
				Row: { id: string; github_repo_id: number; user_id: string | null; workflow_id: number; is_pinned: boolean; environment: 'production' | 'development' | 'unknown'; updated_by: string | null; updated_at: string };
				Insert: { id?: string; github_repo_id: number; user_id?: string | null; workflow_id: number; is_pinned?: boolean; environment?: 'production' | 'development' | 'unknown'; updated_by?: string | null; updated_at?: string };
				Update: { is_pinned?: boolean; environment?: 'production' | 'development' | 'unknown'; updated_by?: string | null; updated_at?: string };
				Relationships: [];
			};
		};
		Views: Record<string, never>;
		Functions: Record<string, never>;
		Enums: Record<string, never>;
	};
}
