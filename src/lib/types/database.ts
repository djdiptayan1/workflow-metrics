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
					scopes?: string[] | null;
					updated_at?: string;
				};
				Relationships: [];
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
				Relationships: [];
			};
			user_settings: {
				Row: {
					id: string;
					user_id: string;
					ai_provider: 'openai' | 'gemini' | 'mistral';
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
					ai_provider?: 'openai' | 'gemini' | 'mistral';
					ai_model?: string | null;
					theme?: 'dark' | 'light' | 'system';
					default_repo_id?: string | null;
					actions_lookback?: '7' | '30' | '90' | 'all';
					dashboard_refresh_interval?: 'realtime' | '5' | '10' | '15';
					created_at?: string;
					updated_at?: string;
				};
				Update: {
					ai_provider?: 'openai' | 'gemini' | 'mistral';
					ai_model?: string | null;
					theme?: 'dark' | 'light' | 'system';
					default_repo_id?: string | null;
					actions_lookback?: '7' | '30' | '90' | 'all';
					dashboard_refresh_interval?: 'realtime' | '5' | '10' | '15';
					updated_at?: string;
				};
				Relationships: [];
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
		Functions: {
			get_user_secret_ciphertexts: {
				Args: { p_user_id: string };
				Returns: Array<{
					github_access_token_ciphertext: string | null;
					ai_api_key_ciphertext: string | null;
					encryption_version: number;
				}>;
			};
			upsert_user_secret_ciphertexts: {
				Args: {
					p_user_id: string;
					p_github_access_token_ciphertext?: string | null;
					p_ai_api_key_ciphertext?: string | null;
				};
				Returns: undefined;
			};
			clear_user_ai_api_key_ciphertext: {
				Args: { p_user_id: string };
				Returns: undefined;
			};
		};
		Enums: Record<string, never>;
		CompositeTypes: Record<string, never>;
	};
}
