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
    PostgrestVersion: "13.0.4"
  }
  public: {
    Tables: {
      admin_users: {
        Row: {
          created_at: string
          email: string
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      advisors: {
        Row: {
          created_at: string
          description: string | null
          email: string | null
          id: number
          name: string | null
          phone: string | null
          photo_url: string | null
          updated_at: string
          VoAdvisor: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          email?: string | null
          id?: number
          name?: string | null
          phone?: string | null
          photo_url?: string | null
          updated_at?: string
          VoAdvisor?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          email?: string | null
          id?: number
          name?: string | null
          phone?: string | null
          photo_url?: string | null
          updated_at?: string
          VoAdvisor?: string | null
        }
        Relationships: []
      }
      appointments: {
        Row: {
          advisor_id: number | null
          client_id: string
          created_at: string
          display_name: string | null
          event_location: string | null
          id: number
          meeting_request: string | null
          message: string | null
          office_location: string | null
          status: string | null
          updated_at: string
        }
        Insert: {
          advisor_id?: number | null
          client_id: string
          created_at?: string
          display_name?: string | null
          event_location?: string | null
          id?: number
          meeting_request?: string | null
          message?: string | null
          office_location?: string | null
          status?: string | null
          updated_at?: string
        }
        Update: {
          advisor_id?: number | null
          client_id?: string
          created_at?: string
          display_name?: string | null
          event_location?: string | null
          id?: number
          meeting_request?: string | null
          message?: string | null
          office_location?: string | null
          status?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointments_advisor_id_fkey"
            columns: ["advisor_id"]
            isOneToOne: false
            referencedRelation: "advisors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          admin_user_id: string
          created_at: string
          id: string
          ip_address: unknown
          params_hash: string | null
          resource: string
          result_status: number
          timestamp: string
          user_agent: string | null
        }
        Insert: {
          action: string
          admin_user_id: string
          created_at?: string
          id?: string
          ip_address?: unknown
          params_hash?: string | null
          resource: string
          result_status: number
          timestamp?: string
          user_agent?: string | null
        }
        Update: {
          action?: string
          admin_user_id?: string
          created_at?: string
          id?: string
          ip_address?: unknown
          params_hash?: string | null
          resource?: string
          result_status?: number
          timestamp?: string
          user_agent?: string | null
        }
        Relationships: []
      }
      client_group_mappings: {
        Row: {
          client_id: string
          group_id: number
          is_subscribed: boolean | null
        }
        Insert: {
          client_id: string
          group_id: number
          is_subscribed?: boolean | null
        }
        Update: {
          client_id?: string
          group_id?: number
          is_subscribed?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "client_group_mappings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          advisor_id: number | null
          age: number | null
          birth_date: string | null
          city: string | null
          company: string | null
          consumer_credit_amount: number | null
          country: string | null
          created_at: string
          email: string
          employment_type: string | null
          figlocfid: string | null
          figlolastsyncat: string | null
          figlorawsnapshot: Json | null
          figlotagname: string | null
          first_name: string | null
          gender: string | null
          gross_income: number | null
          id: string
          initials: string | null
          investment_balance: number | null
          last_name: string | null
          location: string | null
          mailerlite_id: string | null
          marketing_status: string | null
          monthly_fixed_costs: number | null
          monthly_variable_costs: number | null
          net_monthly_income: number | null
          net_monthly_spending: number | null
          pension_income: number | null
          phone: string | null
          planning_status: string | null
          prefix: string | null
          rank: number | null
          referer: string | null
          retirement_target_age: number | null
          risk_profile: string | null
          saving_balance: number | null
          subscription_status: string | null
          supabase_auth_id: string | null
          updated_at: string
          zip: string | null
        }
        Insert: {
          advisor_id?: number | null
          age?: number | null
          birth_date?: string | null
          city?: string | null
          company?: string | null
          consumer_credit_amount?: number | null
          country?: string | null
          created_at?: string
          email: string
          employment_type?: string | null
          figlocfid?: string | null
          figlolastsyncat?: string | null
          figlorawsnapshot?: Json | null
          figlotagname?: string | null
          first_name?: string | null
          gender?: string | null
          gross_income?: number | null
          id?: string
          initials?: string | null
          investment_balance?: number | null
          last_name?: string | null
          location?: string | null
          mailerlite_id?: string | null
          marketing_status?: string | null
          monthly_fixed_costs?: number | null
          monthly_variable_costs?: number | null
          net_monthly_income?: number | null
          net_monthly_spending?: number | null
          pension_income?: number | null
          phone?: string | null
          planning_status?: string | null
          prefix?: string | null
          rank?: number | null
          referer?: string | null
          retirement_target_age?: number | null
          risk_profile?: string | null
          saving_balance?: number | null
          subscription_status?: string | null
          supabase_auth_id?: string | null
          updated_at?: string
          zip?: string | null
        }
        Update: {
          advisor_id?: number | null
          age?: number | null
          birth_date?: string | null
          city?: string | null
          company?: string | null
          consumer_credit_amount?: number | null
          country?: string | null
          created_at?: string
          email?: string
          employment_type?: string | null
          figlocfid?: string | null
          figlolastsyncat?: string | null
          figlorawsnapshot?: Json | null
          figlotagname?: string | null
          first_name?: string | null
          gender?: string | null
          gross_income?: number | null
          id?: string
          initials?: string | null
          investment_balance?: number | null
          last_name?: string | null
          location?: string | null
          mailerlite_id?: string | null
          marketing_status?: string | null
          monthly_fixed_costs?: number | null
          monthly_variable_costs?: number | null
          net_monthly_income?: number | null
          net_monthly_spending?: number | null
          pension_income?: number | null
          phone?: string | null
          planning_status?: string | null
          prefix?: string | null
          rank?: number | null
          referer?: string | null
          retirement_target_age?: number | null
          risk_profile?: string | null
          saving_balance?: number | null
          subscription_status?: string | null
          supabase_auth_id?: string | null
          updated_at?: string
          zip?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clients_advisor_id_fkey"
            columns: ["advisor_id"]
            isOneToOne: false
            referencedRelation: "advisors"
            referencedColumns: ["id"]
          },
        ]
      }
      contracts: {
        Row: {
          client_id: string
          created_at: string
          display_name: string | null
          dvo: number | null
          id: number
          is_damage_client: boolean | null
          max_loan: number | null
          type: string | null
          updated_at: string
          value: number | null
        }
        Insert: {
          client_id: string
          created_at?: string
          display_name?: string | null
          dvo?: number | null
          id?: number
          is_damage_client?: boolean | null
          max_loan?: number | null
          type?: string | null
          updated_at?: string
          value?: number | null
        }
        Update: {
          client_id?: string
          created_at?: string
          display_name?: string | null
          dvo?: number | null
          id?: number
          is_damage_client?: boolean | null
          max_loan?: number | null
          type?: string | null
          updated_at?: string
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "contracts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      estate_planning_documents: {
        Row: {
          client_id: string
          created_at: string
          document_type: string | null
          id: number
          location: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          document_type?: string | null
          id?: number
          location?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          document_type?: string | null
          id?: number
          location?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "estate_planning_documents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_goals: {
        Row: {
          amount: number | null
          client_id: string
          created_at: string
          description: string | null
          goal_priority: string | null
          id: number
          updated_at: string
        }
        Insert: {
          amount?: number | null
          client_id: string
          created_at?: string
          description?: string | null
          goal_priority?: string | null
          id?: number
          updated_at?: string
        }
        Update: {
          amount?: number | null
          client_id?: string
          created_at?: string
          description?: string | null
          goal_priority?: string | null
          id?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "financial_goals_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      house_objects: {
        Row: {
          annuity_amount: number | null
          annuity_target_amount: number | null
          client_id: string
          created_at: string
          current_rent: number | null
          display_name: string | null
          energy_label: string | null
          figlosourceid: string | null
          home_value: number | null
          id: number
          is_owner_occupied: boolean | null
          ltv: number | null
          mortgage_amount: number | null
          mortgage_interest_rate: number | null
          mortgage_remaining: number | null
          updated_at: string
        }
        Insert: {
          annuity_amount?: number | null
          annuity_target_amount?: number | null
          client_id: string
          created_at?: string
          current_rent?: number | null
          display_name?: string | null
          energy_label?: string | null
          figlosourceid?: string | null
          home_value?: number | null
          id?: number
          is_owner_occupied?: boolean | null
          ltv?: number | null
          mortgage_amount?: number | null
          mortgage_interest_rate?: number | null
          mortgage_remaining?: number | null
          updated_at?: string
        }
        Update: {
          annuity_amount?: number | null
          annuity_target_amount?: number | null
          client_id?: string
          created_at?: string
          current_rent?: number | null
          display_name?: string | null
          energy_label?: string | null
          figlosourceid?: string | null
          home_value?: number | null
          id?: number
          is_owner_occupied?: boolean | null
          ltv?: number | null
          mortgage_amount?: number | null
          mortgage_interest_rate?: number | null
          mortgage_remaining?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "house_objects_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      insurances: {
        Row: {
          client_id: string
          created_at: string
          death_risk_assurance_amount: number | null
          disability_percentage: number | null
          display_name: string | null
          figlosourceid: string | null
          id: number
          type: string | null
          updated_at: string
          value: number | null
        }
        Insert: {
          client_id: string
          created_at?: string
          death_risk_assurance_amount?: number | null
          disability_percentage?: number | null
          display_name?: string | null
          figlosourceid?: string | null
          id?: number
          type?: string | null
          updated_at?: string
          value?: number | null
        }
        Update: {
          client_id?: string
          created_at?: string
          death_risk_assurance_amount?: number | null
          disability_percentage?: number | null
          display_name?: string | null
          figlosourceid?: string | null
          id?: number
          type?: string | null
          updated_at?: string
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "insurances_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_crosswalk: {
        Row: {
          a_id: string | null
          b_id: string | null
          created_at: string
          email: string
          id: string
          updated_at: string
        }
        Insert: {
          a_id?: string | null
          b_id?: string | null
          created_at?: string
          email: string
          id?: string
          updated_at?: string
        }
        Update: {
          a_id?: string | null
          b_id?: string | null
          created_at?: string
          email?: string
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_crosswalk_client"
            columns: ["a_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_crosswalk_groups: {
        Row: {
          a_group_id: number
          b_group_id: string | null
          created_at: string
          email: string
          updated_at: string
        }
        Insert: {
          a_group_id: number
          b_group_id?: string | null
          created_at?: string
          email: string
          updated_at?: string
        }
        Update: {
          a_group_id?: number
          b_group_id?: string | null
          created_at?: string
          email?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_crosswalk_groups_a_group_id_fkey"
            columns: ["a_group_id"]
            isOneToOne: false
            referencedRelation: "mailerlite_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      investments: {
        Row: {
          client_id: string
          created_at: string
          current_value: number | null
          figlosourceid: string | null
          id: number
          name: string | null
          type: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          current_value?: number | null
          figlosourceid?: string | null
          id?: number
          name?: string | null
          type?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          current_value?: number | null
          figlosourceid?: string | null
          id?: number
          name?: string | null
          type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "investments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      liabilities: {
        Row: {
          client_id: string
          created_at: string
          figlosourceid: string | null
          id: number
          name: string | null
          total_amount: number | null
          type: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          figlosourceid?: string | null
          id?: number
          name?: string | null
          total_amount?: number | null
          type?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          figlosourceid?: string | null
          id?: number
          name?: string | null
          total_amount?: number | null
          type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "liabilities_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      mailerlite_groups: {
        Row: {
          created_at: string
          id: number
          ml_group_id: string | null
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: number
          ml_group_id?: string | null
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: number
          ml_group_id?: string | null
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      managed_mailerlite_groups: {
        Row: {
          created_at: string
          group_name: string
          id: number
          ml_group_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          group_name: string
          id?: number
          ml_group_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          group_name?: string
          id?: number
          ml_group_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      partners: {
        Row: {
          advisor_id: number | null
          client_id: string
          created_at: string
          email: string | null
          figlosourceid: string | null
          first_name: string | null
          gender: string | null
          gross_income: number | null
          id: number
          initials: string | null
          last_name: string | null
          prefix: string | null
          updated_at: string
        }
        Insert: {
          advisor_id?: number | null
          client_id: string
          created_at?: string
          email?: string | null
          figlosourceid?: string | null
          first_name?: string | null
          gender?: string | null
          gross_income?: number | null
          id?: number
          initials?: string | null
          last_name?: string | null
          prefix?: string | null
          updated_at?: string
        }
        Update: {
          advisor_id?: number | null
          client_id?: string
          created_at?: string
          email?: string | null
          figlosourceid?: string | null
          first_name?: string | null
          gender?: string | null
          gross_income?: number | null
          id?: number
          initials?: string | null
          last_name?: string | null
          prefix?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "partners_advisor_id_fkey"
            columns: ["advisor_id"]
            isOneToOne: false
            referencedRelation: "advisors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "partners_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      pensions: {
        Row: {
          client_id: string
          created_at: string
          expected_annual_payout: number | null
          figlosourceid: string | null
          id: number
          provider: string | null
          type: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          expected_annual_payout?: number | null
          figlosourceid?: string | null
          id?: number
          provider?: string | null
          type?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          expected_annual_payout?: number | null
          figlosourceid?: string | null
          id?: number
          provider?: string | null
          type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pensions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_conflicts: {
        Row: {
          a_value: string | null
          b_value: string | null
          created_at: string
          detected_at: string
          email: string
          field: string
          id: string
          resolved_at: string | null
          resolved_value: string | null
          status: string
          updated_at: string
        }
        Insert: {
          a_value?: string | null
          b_value?: string | null
          created_at?: string
          detected_at?: string
          email: string
          field: string
          id?: string
          resolved_at?: string | null
          resolved_value?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          a_value?: string | null
          b_value?: string | null
          created_at?: string
          detected_at?: string
          email?: string
          field?: string
          id?: string
          resolved_at?: string | null
          resolved_value?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      sync_log: {
        Row: {
          action: string
          created_at: string
          dedupe_key: string | null
          direction: string
          email: string
          error_type: string | null
          field: string | null
          id: string
          new_value: string | null
          old_value: string | null
          result: string
          status_code: number | null
        }
        Insert: {
          action: string
          created_at?: string
          dedupe_key?: string | null
          direction: string
          email: string
          error_type?: string | null
          field?: string | null
          id?: string
          new_value?: string | null
          old_value?: string | null
          result: string
          status_code?: number | null
        }
        Update: {
          action?: string
          created_at?: string
          dedupe_key?: string | null
          direction?: string
          email?: string
          error_type?: string | null
          field?: string | null
          id?: string
          new_value?: string | null
          old_value?: string | null
          result?: string
          status_code?: number | null
        }
        Relationships: []
      }
      sync_runs: {
        Row: {
          completed_at: string | null
          conflicts_detected: number | null
          created_at: string
          dry_run: boolean
          emails_processed: number | null
          error_details: Json | null
          errors_count: number | null
          id: string
          mode: string
          records_created: number | null
          records_skipped: number | null
          records_updated: number | null
          started_at: string
          status: string
          summary: Json | null
        }
        Insert: {
          completed_at?: string | null
          conflicts_detected?: number | null
          created_at?: string
          dry_run?: boolean
          emails_processed?: number | null
          error_details?: Json | null
          errors_count?: number | null
          id?: string
          mode: string
          records_created?: number | null
          records_skipped?: number | null
          records_updated?: number | null
          started_at?: string
          status?: string
          summary?: Json | null
        }
        Update: {
          completed_at?: string | null
          conflicts_detected?: number | null
          created_at?: string
          dry_run?: boolean
          emails_processed?: number | null
          error_details?: Json | null
          errors_count?: number | null
          id?: string
          mode?: string
          records_created?: number | null
          records_skipped?: number | null
          records_updated?: number | null
          started_at?: string
          status?: string
          summary?: Json | null
        }
        Relationships: []
      }
      sync_shadow: {
        Row: {
          created_at: string
          data_quality: Json | null
          email: string
          id: string
          last_validated_at: string | null
          snapshot: Json
          updated_at: string
          validation_status: string | null
        }
        Insert: {
          created_at?: string
          data_quality?: Json | null
          email: string
          id?: string
          last_validated_at?: string | null
          snapshot?: Json
          updated_at?: string
          validation_status?: string | null
        }
        Update: {
          created_at?: string
          data_quality?: Json | null
          email?: string
          id?: string
          last_validated_at?: string | null
          snapshot?: Json
          updated_at?: string
          validation_status?: string | null
        }
        Relationships: []
      }
      sync_state: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value?: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      tax_parameters: {
        Row: {
          code: string
          country: string
          currency: string | null
          id: string
          name: string
          regime: string
          source_ref: string | null
          source_url: string | null
          status: string
          unit: string | null
          updated_at: string | null
          valid_from: string
          valid_to: string | null
          value_numeric: number | null
          value_text: string | null
        }
        Insert: {
          code: string
          country?: string
          currency?: string | null
          id?: string
          name: string
          regime: string
          source_ref?: string | null
          source_url?: string | null
          status: string
          unit?: string | null
          updated_at?: string | null
          valid_from: string
          valid_to?: string | null
          value_numeric?: number | null
          value_text?: string | null
        }
        Update: {
          code?: string
          country?: string
          currency?: string | null
          id?: string
          name?: string
          regime?: string
          source_ref?: string | null
          source_url?: string | null
          status?: string
          unit?: string | null
          updated_at?: string | null
          valid_from?: string
          valid_to?: string | null
          value_numeric?: number | null
          value_text?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string | null
          created_by: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      v_clients_for_ml: {
        Row: {
          city: string | null
          country: string | null
          email: string | null
          first_name: string | null
          groups: string[] | null
          last_name: string | null
          phone: string | null
        }
        Insert: {
          city?: never
          country?: never
          email?: string | null
          first_name?: never
          groups?: never
          last_name?: never
          phone?: never
        }
        Update: {
          city?: never
          country?: never
          email?: string | null
          first_name?: never
          groups?: never
          last_name?: never
          phone?: never
        }
        Relationships: []
      }
      v_clients_for_ml_secure: {
        Row: {
          city: string | null
          country: string | null
          email: string | null
          first_name: string | null
          groups: string[] | null
          last_name: string | null
          phone: string | null
        }
        Insert: {
          city?: string | null
          country?: string | null
          email?: string | null
          first_name?: string | null
          groups?: never
          last_name?: string | null
          phone?: string | null
        }
        Update: {
          city?: string | null
          country?: string | null
          email?: string | null
          first_name?: string | null
          groups?: never
          last_name?: string | null
          phone?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      check_duplicate_advisors: {
        Args: never
        Returns: {
          count: number
          ids: string
          name: string
        }[]
      }
      full_client: {
        Args: { email: string }
        Returns: {
          age: number
          annuity_amount: number
          annuity_target_amount: number
          consumer_credit_amount: number
          contract_display_name: string
          contract_id: number
          contract_type: string
          contract_value: number
          country: string
          current_rent: number
          death_risk_assurance_amount: number
          disability_percentage: number
          dvo: number
          email: string
          employment_type: string
          energy_label: string
          financial_goal_amount: number
          financial_goal_description: string
          financial_goal_id: number
          first_name: string
          goal_priority: string
          gross_income: number
          home_value: number
          house_id: number
          house_ltv: number
          id: string
          insurance_display_name: string
          insurance_id: number
          insurance_type: string
          insurance_value: number
          investment_balance: number
          investment_current_value: number
          investment_id: number
          investment_name: string
          investment_type: string
          is_damage_client: boolean
          is_owner_occupied: boolean
          last_name: string
          liability_id: number
          liability_name: string
          liability_total_amount: number
          liability_type: string
          max_loan: number
          monthly_fixed_costs: number
          monthly_variable_costs: number
          mortgage_interest_rate: number
          mortgage_remaining: number
          net_monthly_income: number
          net_monthly_spending: number
          pension_income: number
          phone: string
          planning_status: string
          retirement_target_age: number
          risk_profile: string
          saving_balance: number
          supabase_auth_id: string
        }[]
      }
      full_client_v2: {
        Args: { p_email: string }
        Returns: {
          advisor_email: string
          advisor_name: string
          age: number
          annuity_amount: number
          annuity_target_amount: number
          birth_date: string
          consumer_credit_amount: number
          contract_id: number
          country: string
          current_rent: number
          death_risk_assurance_amount: number
          disability_percentage: number
          dvo: number
          email: string
          employment_type: string
          energy_label: string
          financial_goal_amount: number
          financial_goal_description: string
          financial_goal_id: number
          first_name: string
          gender: string
          goal_priority: string
          gross_income: number
          home_value: number
          house_id: number
          id: string
          initials: string
          insurance_id: number
          insurance_premiums_total: number
          investment_balance: number
          investment_current_value: number
          investment_id: number
          is_damage_client: boolean
          is_owner_occupied: boolean
          last_name: string
          liability_id: number
          liability_total_amount: number
          max_loan: number
          monthly_fixed_costs: number
          monthly_variable_costs: number
          mortgage_amount: number
          mortgage_interest_rate: number
          mortgage_remaining: number
          net_monthly_income: number
          net_monthly_spending: number
          partner_gross_income: number
          pension_income: number
          phone: string
          planning_status: string
          prefix: string
          retirement_target_age: number
          risk_profile: string
          saving_balance: number
          supabase_auth_id: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      link_client_auth_id: { Args: never; Returns: undefined }
      safe_to_float: { Args: { val: string }; Returns: number }
      safe_to_int: { Args: { val: string }; Returns: number }
      sync_figlo_client: {
        Args: {
          p_client: Json
          p_client_id: string
          p_houses?: Json
          p_insurances?: Json
          p_investments?: Json
          p_liabilities?: Json
          p_partners?: Json
          p_pensions?: Json
        }
        Returns: undefined
      }
      sync_figlo_client_v2: {
        Args: {
          p_client: Json
          p_client_id: string
          p_houses?: Json
          p_insurances?: Json
          p_investments?: Json
          p_liabilities?: Json
          p_partners?: Json
          p_pensions?: Json
        }
        Returns: undefined
      }
      upsert_tax_parameter: { Args: { p: Json }; Returns: undefined }
      v_tax_parameters_on: {
        Args: { peildatum: string }
        Returns: {
          code: string
          country: string
          currency: string | null
          id: string
          name: string
          regime: string
          source_ref: string | null
          source_url: string | null
          status: string
          unit: string | null
          updated_at: string | null
          valid_from: string
          valid_to: string | null
          value_numeric: number | null
          value_text: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "tax_parameters"
          isOneToOne: false
          isSetofReturn: true
        }
      }
    }
    Enums: {
      app_role: "admin" | "user"
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
    Enums: {
      app_role: ["admin", "user"],
    },
  },
} as const
