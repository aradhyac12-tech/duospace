export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      backup_runs: {
        Row: {
          created_at: string
          error: string | null
          file_id: string | null
          id: string
          provider: string
          size_bytes: number | null
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          error?: string | null
          file_id?: string | null
          id?: string
          provider?: string
          size_bytes?: number | null
          status: string
          user_id: string
        }
        Update: {
          created_at?: string
          error?: string | null
          file_id?: string | null
          id?: string
          provider?: string
          size_bytes?: number | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      blocked_users: {
        Row: {
          blocked_user_id: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          blocked_user_id: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          blocked_user_id?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      blend_invites: {
        Row: {
          created_at: string
          id: string
          sender_id: string
          status: string
        }
        Insert: {
          created_at?: string
          id?: string
          sender_id: string
          status?: string
        }
        Update: {
          created_at?: string
          id?: string
          sender_id?: string
          status?: string
        }
        Relationships: []
      }
      call_history: {
        Row: {
          call_direction: string
          call_type: string
          caller_id: string
          created_at: string
          duration_seconds: number | null
          ended_at: string | null
          id: string
          receiver_id: string | null
          room_name: string | null
          started_at: string
          status: string
        }
        Insert: {
          call_direction?: string
          call_type?: string
          caller_id: string
          created_at?: string
          duration_seconds?: number | null
          ended_at?: string | null
          id?: string
          receiver_id?: string | null
          room_name?: string | null
          started_at?: string
          status?: string
        }
        Update: {
          call_direction?: string
          call_type?: string
          caller_id?: string
          created_at?: string
          duration_seconds?: number | null
          ended_at?: string | null
          id?: string
          receiver_id?: string | null
          room_name?: string | null
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      code_surprise_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          surprise_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          surprise_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          surprise_id?: string
          user_id?: string
        }
        Relationships: []
      }
      code_surprises: {
        Row: {
          created_at: string
          creator_id: string
          css_content: string
          html_content: string
          id: string
          is_active: boolean
          js_content: string
          max_views: number
          title: string
          views_used: number
        }
        Insert: {
          created_at?: string
          creator_id: string
          css_content?: string
          html_content?: string
          id?: string
          is_active?: boolean
          js_content?: string
          max_views?: number
          title?: string
          views_used?: number
        }
        Update: {
          created_at?: string
          creator_id?: string
          css_content?: string
          html_content?: string
          id?: string
          is_active?: boolean
          js_content?: string
          max_views?: number
          title?: string
          views_used?: number
        }
        Relationships: []
      }
      countdowns: {
        Row: {
          created_at: string
          creator_id: string
          emoji: string | null
          id: string
          target_date: string
          title: string
        }
        Insert: {
          created_at?: string
          creator_id: string
          emoji?: string | null
          id?: string
          target_date: string
          title: string
        }
        Update: {
          created_at?: string
          creator_id?: string
          emoji?: string | null
          id?: string
          target_date?: string
          title?: string
        }
        Relationships: []
      }
      daily_answers: {
        Row: {
          answer: string
          created_at: string
          id: string
          question: string
          question_date: string
          user_id: string
        }
        Insert: {
          answer: string
          created_at?: string
          id?: string
          question: string
          question_date?: string
          user_id: string
        }
        Update: {
          answer?: string
          created_at?: string
          id?: string
          question?: string
          question_date?: string
          user_id?: string
        }
        Relationships: []
      }
      email_change_otps: {
        Row: {
          attempts: number
          consumed_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          otp_hash: string
          user_id: string
        }
        Insert: {
          attempts?: number
          consumed_at?: string | null
          created_at?: string
          email: string
          expires_at: string
          id?: string
          otp_hash: string
          user_id: string
        }
        Update: {
          attempts?: number
          consumed_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          otp_hash?: string
          user_id?: string
        }
        Relationships: []
      }
      gallery_items: {
        Row: {
          created_at: string
          file_name: string | null
          file_type: string
          file_url: string
          id: string
          is_shared: boolean
          owner_id: string
        }
        Insert: {
          created_at?: string
          file_name?: string | null
          file_type?: string
          file_url: string
          id?: string
          is_shared?: boolean
          owner_id: string
        }
        Update: {
          created_at?: string
          file_name?: string | null
          file_type?: string
          file_url?: string
          id?: string
          is_shared?: boolean
          owner_id?: string
        }
        Relationships: []
      }
      imported_chats: {
        Row: {
          content: string | null
          created_at: string
          file_type: string | null
          file_url: string | null
          id: string
          original_timestamp: string
          owner_id: string
          sender_name: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          file_type?: string | null
          file_url?: string | null
          id?: string
          original_timestamp: string
          owner_id: string
          sender_name: string
        }
        Update: {
          content?: string | null
          created_at?: string
          file_type?: string | null
          file_url?: string | null
          id?: string
          original_timestamp?: string
          owner_id?: string
          sender_name?: string
        }
        Relationships: []
      }
      invite_links: {
        Row: {
          code: string
          created_at: string
          creator_id: string
          expires_at: string
          id: string
          used_at: string | null
          used_by: string | null
        }
        Insert: {
          code: string
          created_at?: string
          creator_id: string
          expires_at?: string
          id?: string
          used_at?: string | null
          used_by?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          creator_id?: string
          expires_at?: string
          id?: string
          used_at?: string | null
          used_by?: string | null
        }
        Relationships: []
      }
      known_devices: {
        Row: {
          fingerprint: string
          first_seen_at: string
          id: string
          label: string | null
          last_seen_at: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          fingerprint: string
          first_seen_at?: string
          id?: string
          label?: string | null
          last_seen_at?: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          fingerprint?: string
          first_seen_at?: string
          id?: string
          label?: string | null
          last_seen_at?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      locations: {
        Row: {
          id: string
          latitude: number
          longitude: number
          updated_at: string
          user_id: string
        }
        Insert: {
          id?: string
          latitude: number
          longitude: number
          updated_at?: string
          user_id: string
        }
        Update: {
          id?: string
          latitude?: number
          longitude?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      memories: {
        Row: {
          caption: string | null
          created_at: string
          creator_id: string
          id: string
          image_url: string | null
        }
        Insert: {
          caption?: string | null
          created_at?: string
          creator_id: string
          id?: string
          image_url?: string | null
        }
        Update: {
          caption?: string | null
          created_at?: string
          creator_id?: string
          id?: string
          image_url?: string | null
        }
        Relationships: []
      }
      menstrual_cycles: {
        Row: {
          created_at: string
          cycle_length: number
          cycle_start_date: string
          id: string
          notes: string | null
          period_length: number
          user_id: string
        }
        Insert: {
          created_at?: string
          cycle_length?: number
          cycle_start_date: string
          id?: string
          notes?: string | null
          period_length?: number
          user_id: string
        }
        Update: {
          created_at?: string
          cycle_length?: number
          cycle_start_date?: string
          id?: string
          notes?: string | null
          period_length?: number
          user_id?: string
        }
        Relationships: []
      }
      message_reactions: {
        Row: {
          created_at: string
          emoji: string
          id: string
          message_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          emoji: string
          id?: string
          message_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          emoji?: string
          id?: string
          message_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_reactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          content: string | null
          created_at: string
          deleted_by_receiver: boolean
          deleted_by_sender: boolean
          disappear_at: string | null
          edited_at: string | null
          file_name: string | null
          file_url: string | null
          id: string
          is_pinned: boolean
          is_read: boolean
          message_type: string
          receiver_id: string
          reply_to_id: string | null
          sender_id: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          deleted_by_receiver?: boolean
          deleted_by_sender?: boolean
          disappear_at?: string | null
          edited_at?: string | null
          file_name?: string | null
          file_url?: string | null
          id?: string
          is_pinned?: boolean
          is_read?: boolean
          message_type?: string
          receiver_id: string
          reply_to_id?: string | null
          sender_id: string
        }
        Update: {
          content?: string | null
          created_at?: string
          deleted_by_receiver?: boolean
          deleted_by_sender?: boolean
          disappear_at?: string | null
          edited_at?: string | null
          file_name?: string | null
          file_url?: string | null
          id?: string
          is_pinned?: boolean
          is_read?: boolean
          message_type?: string
          receiver_id?: string
          reply_to_id?: string | null
          sender_id?: string
        }
        Relationships: []
      }
      mood_logs: {
        Row: {
          arousal: number | null
          confidence: number
          created_at: string
          detected_at: string
          feedback: string | null
          // Manually added 2026-07-31 alongside migration
          // 20260731050000_add_mood_logs_features_column.sql — the column
          // already existed in application code (MoodDetector.tsx) via an
          // `as any` cast, but was never actually in the schema until that
          // migration. Re-run `supabase gen types` against the live
          // project once the migration is applied, to replace this
          // hand-edit with a real codegen pass.
          features: Json | null
          id: string
          mood: string
          user_id: string
          valence: number | null
        }
        Insert: {
          arousal?: number | null
          confidence?: number
          created_at?: string
          detected_at?: string
          feedback?: string | null
          features?: Json | null
          id?: string
          mood: string
          user_id: string
          valence?: number | null
        }
        Update: {
          arousal?: number | null
          confidence?: number
          created_at?: string
          detected_at?: string
          feedback?: string | null
          features?: Json | null
          id?: string
          mood?: string
          user_id?: string
          valence?: number | null
        }
        Relationships: []
      }
      notification_history: {
        Row: {
          body: string | null
          conversation_id: string | null
          created_at: string
          data: Json
          delivery_status: string
          error_detail: string | null
          fcm_message_ids: string[] | null
          id: string
          is_read: boolean
          notification_type: string
          read_at: string | null
          recipient_id: string
          related_id: string | null
          sender_id: string | null
          skip_reason: string | null
          title: string | null
          tokens_attempted: number
          tokens_succeeded: number
        }
        Insert: {
          body?: string | null
          conversation_id?: string | null
          created_at?: string
          data?: Json
          delivery_status?: string
          error_detail?: string | null
          fcm_message_ids?: string[] | null
          id?: string
          is_read?: boolean
          notification_type: string
          read_at?: string | null
          recipient_id: string
          related_id?: string | null
          sender_id?: string | null
          skip_reason?: string | null
          title?: string | null
          tokens_attempted?: number
          tokens_succeeded?: number
        }
        Update: {
          body?: string | null
          conversation_id?: string | null
          created_at?: string
          data?: Json
          delivery_status?: string
          error_detail?: string | null
          fcm_message_ids?: string[] | null
          id?: string
          is_read?: boolean
          notification_type?: string
          read_at?: string | null
          recipient_id?: string
          related_id?: string | null
          sender_id?: string | null
          skip_reason?: string | null
          title?: string | null
          tokens_attempted?: number
          tokens_succeeded?: number
        }
        Relationships: []
      }
      notification_preferences: {
        Row: {
          calls_enabled: boolean
          call_ringtone: string
          do_not_disturb: boolean
          friend_requests_enabled: boolean
          group_enabled: boolean
          mentions_enabled: boolean
          message_sound: string
          messages_enabled: boolean
          muted_until: string | null
          reactions_enabled: boolean
          replies_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          calls_enabled?: boolean
          call_ringtone?: string
          do_not_disturb?: boolean
          friend_requests_enabled?: boolean
          group_enabled?: boolean
          mentions_enabled?: boolean
          message_sound?: string
          messages_enabled?: boolean
          muted_until?: string | null
          reactions_enabled?: boolean
          replies_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          calls_enabled?: boolean
          call_ringtone?: string
          do_not_disturb?: boolean
          friend_requests_enabled?: boolean
          group_enabled?: boolean
          mentions_enabled?: boolean
          message_sound?: string
          messages_enabled?: boolean
          muted_until?: string | null
          reactions_enabled?: boolean
          replies_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      partner_requests: {
        Row: {
          created_at: string
          id: string
          receiver_id: string
          sender_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          receiver_id: string
          sender_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          receiver_id?: string
          sender_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      pending_uploads: {
        Row: {
          bucket: string
          content_type: string | null
          created_at: string
          id: string
          object_path: string
          total_bytes: number | null
          total_chunks: number
          updated_at: string
          uploaded_chunks: number
          user_id: string
        }
        Insert: {
          bucket: string
          content_type?: string | null
          created_at?: string
          id?: string
          object_path: string
          total_bytes?: number | null
          total_chunks: number
          updated_at?: string
          uploaded_chunks?: number
          user_id: string
        }
        Update: {
          bucket?: string
          content_type?: string | null
          created_at?: string
          id?: string
          object_path?: string
          total_bytes?: number | null
          total_chunks?: number
          updated_at?: string
          uploaded_chunks?: number
          user_id?: string
        }
        Relationships: []
      }
      playlist_songs: {
        Row: {
          added_by: string
          artist: string
          created_at: string
          id: string
          platform: string
          song_url: string
          thumbnail_url: string | null
          title: string
        }
        Insert: {
          added_by: string
          artist?: string
          created_at?: string
          id?: string
          platform?: string
          song_url: string
          thumbnail_url?: string | null
          title: string
        }
        Update: {
          added_by?: string
          artist?: string
          created_at?: string
          id?: string
          platform?: string
          song_url?: string
          thumbnail_url?: string | null
          title?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          app_visibility: string | null
          avatar_url: string | null
          couple_theme: string | null
          created_at: string
          device_platform: string | null
          display_name: string
          gallery_shared: boolean
          gender: string | null
          id: string
          last_seen_at: string | null
          location_mode: string
          mood_emoji: string | null
          mood_text: string | null
          mood_updated_at: string | null
          partner_id: string | null
          pet_name: string | null
          phone_number: string | null
          public_key: string | null
          push_platform: string | null
          push_token: string | null
          tracking_state: string | null
          updated_at: string
          user_id: string
          username: string | null
        }
        Insert: {
          app_visibility?: string | null
          avatar_url?: string | null
          couple_theme?: string | null
          created_at?: string
          device_platform?: string | null
          display_name?: string
          gallery_shared?: boolean
          gender?: string | null
          id?: string
          last_seen_at?: string | null
          location_mode?: string
          mood_emoji?: string | null
          mood_text?: string | null
          mood_updated_at?: string | null
          partner_id?: string | null
          pet_name?: string | null
          phone_number?: string | null
          public_key?: string | null
          push_platform?: string | null
          push_token?: string | null
          tracking_state?: string | null
          updated_at?: string
          user_id: string
          username?: string | null
        }
        Update: {
          app_visibility?: string | null
          avatar_url?: string | null
          couple_theme?: string | null
          created_at?: string
          device_platform?: string | null
          display_name?: string
          gallery_shared?: boolean
          gender?: string | null
          id?: string
          last_seen_at?: string | null
          location_mode?: string
          mood_emoji?: string | null
          mood_text?: string | null
          mood_updated_at?: string | null
          partner_id?: string | null
          pet_name?: string | null
          phone_number?: string | null
          public_key?: string | null
          push_platform?: string | null
          push_token?: string | null
          tracking_state?: string | null
          updated_at?: string
          user_id?: string
          username?: string | null
        }
        Relationships: []
      }
      push_tokens: {
        Row: {
          app_version: string | null
          created_at: string
          device_id: string | null
          id: string
          invalidated_reason: string | null
          is_valid: boolean
          last_used_at: string
          platform: string
          token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          app_version?: string | null
          created_at?: string
          device_id?: string | null
          id?: string
          invalidated_reason?: string | null
          is_valid?: boolean
          last_used_at?: string
          platform?: string
          token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          app_version?: string | null
          created_at?: string
          device_id?: string | null
          id?: string
          invalidated_reason?: string | null
          is_valid?: boolean
          last_used_at?: string
          platform?: string
          token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      qr_pairing_tokens: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          issuer_ip: string | null
          issuer_ua: string | null
          pending_partner_for: string | null
          redeemed_at: string | null
          redeemed_by_user_id: string | null
          redeemed_ip: string | null
          redeemed_ua: string | null
          token_hash: string
          token_type: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          issuer_ip?: string | null
          issuer_ua?: string | null
          pending_partner_for?: string | null
          redeemed_at?: string | null
          redeemed_by_user_id?: string | null
          redeemed_ip?: string | null
          redeemed_ua?: string | null
          token_hash: string
          token_type?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          issuer_ip?: string | null
          issuer_ua?: string | null
          pending_partner_for?: string | null
          redeemed_at?: string | null
          redeemed_by_user_id?: string | null
          redeemed_ip?: string | null
          redeemed_ua?: string | null
          token_hash?: string
          token_type?: string
          user_id?: string | null
        }
        Relationships: []
      }
      rate_limits: {
        Row: {
          bucket: string
          hit_at: string
          id: string
          user_id: string
        }
        Insert: {
          bucket: string
          hit_at?: string
          id?: string
          user_id: string
        }
        Update: {
          bucket?: string
          hit_at?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      scheduled_messages: {
        Row: {
          content: string | null
          created_at: string
          disappear_at: string | null
          id: string
          is_processing: boolean
          message_type: string
          receiver_id: string
          send_at: string
          sender_id: string
          sent: boolean
        }
        Insert: {
          content?: string | null
          created_at?: string
          disappear_at?: string | null
          id?: string
          is_processing?: boolean
          message_type?: string
          receiver_id: string
          send_at: string
          sender_id: string
          sent?: boolean
        }
        Update: {
          content?: string | null
          created_at?: string
          disappear_at?: string | null
          id?: string
          is_processing?: boolean
          message_type?: string
          receiver_id?: string
          send_at?: string
          sender_id?: string
          sent?: boolean
        }
        Relationships: []
      }
      shayaris: {
        Row: {
          content: string
          created_at: string
          delete_requested_by: string | null
          id: string
          is_favorite: boolean
          title: string | null
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          delete_requested_by?: string | null
          id?: string
          is_favorite?: boolean
          title?: string | null
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          delete_requested_by?: string | null
          id?: string
          is_favorite?: boolean
          title?: string | null
          user_id?: string
        }
        Relationships: []
      }
      taps: {
        Row: {
          created_at: string
          id: string
          receiver_id: string | null
          sender_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          receiver_id?: string | null
          sender_id: string
        }
        Update: {
          created_at?: string
          id?: string
          receiver_id?: string | null
          sender_id?: string
        }
        Relationships: []
      }
      user_secrets: {
        Row: {
          created_at: string
          daily_api_key: string | null
          daily_key_hint: string | null
          daily_provides_calls: boolean
          google_drive_connected_at: string | null
          google_drive_email: string | null
          google_drive_refresh_token: string | null
          last_backup_at: string | null
          last_backup_error: string | null
          last_backup_file_id: string | null
          last_backup_size: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          daily_api_key?: string | null
          daily_key_hint?: string | null
          daily_provides_calls?: boolean
          google_drive_connected_at?: string | null
          google_drive_email?: string | null
          google_drive_refresh_token?: string | null
          last_backup_at?: string | null
          last_backup_error?: string | null
          last_backup_file_id?: string | null
          last_backup_size?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          daily_api_key?: string | null
          daily_key_hint?: string | null
          daily_provides_calls?: boolean
          google_drive_connected_at?: string | null
          google_drive_email?: string | null
          google_drive_refresh_token?: string | null
          last_backup_at?: string | null
          last_backup_error?: string | null
          last_backup_file_id?: string | null
          last_backup_size?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      webauthn_challenges: {
        Row: {
          challenge: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          kind: string
          user_id: string | null
        }
        Insert: {
          challenge: string
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          kind: string
          user_id?: string | null
        }
        Update: {
          challenge?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          kind?: string
          user_id?: string | null
        }
        Relationships: []
      }
      webauthn_credentials: {
        Row: {
          aaguid: string | null
          counter: number
          created_at: string
          credential_id: string
          device_name: string | null
          id: string
          last_used_at: string | null
          public_key: string
          transports: string[]
          user_id: string
        }
        Insert: {
          aaguid?: string | null
          counter?: number
          created_at?: string
          credential_id: string
          device_name?: string | null
          id?: string
          last_used_at?: string | null
          public_key: string
          transports?: string[]
          user_id: string
        }
        Update: {
          aaguid?: string | null
          counter?: number
          created_at?: string
          credential_id?: string
          device_name?: string | null
          id?: string
          last_used_at?: string | null
          public_key?: string
          transports?: string[]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_invite: {
        Args: { p_code: string; p_user_id: string }
        Returns: Json
      }
      accept_partner_request: {
        Args: { p_request_id: string; p_user_id: string }
        Returns: undefined
      }
      accept_partner_request_v2: {
        Args: { accepting_user_id: string; request_id: string }
        Returns: Json
      }
      claim_pending_scheduled_messages: {
        Args: never
        Returns: {
          content: string | null
          created_at: string
          disappear_at: string | null
          id: string
          is_processing: boolean
          message_type: string
          receiver_id: string
          send_at: string
          sender_id: string
          sent: boolean
        }[]
        SetofOptions: {
          from: "*"
          to: "scheduled_messages"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      cleanup_disappeared_messages: { Args: never; Returns: undefined }
      complete_qr_pending_link: { Args: { _user_id: string }; Returns: string }
      consume_rate_limit: {
        Args: {
          _bucket: string
          _max: number
          _user_id: string
          _window_seconds: number
        }
        Returns: boolean
      }
      delete_expired_messages: { Args: never; Returns: undefined }
      email_change_otps_gc: { Args: never; Returns: undefined }
      get_partner_daily_key: { Args: { _user_id: string }; Returns: string }
      get_partner_id: { Args: { _user_id: string }; Returns: string }
      get_user_id_by_email: { Args: { _email: string }; Returns: string }
      link_partners: { Args: { _a: string; _b: string }; Returns: undefined }
      qr_pairing_tokens_gc: { Args: never; Returns: undefined }
      search_users: {
        Args: { search_term: string }
        Returns: {
          avatar_url: string
          display_name: string
          user_id: string
          username: string
        }[]
      }
      unlink_partner: { Args: { p_user_id: string }; Returns: undefined }
      webauthn_challenges_gc: { Args: never; Returns: undefined }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
