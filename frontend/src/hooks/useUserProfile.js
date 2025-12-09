import { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';

export const useUserProfile = () => {
  const { user } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user?.id) {
      setLoading(true);
      
      supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single()
        .then(({ data, error }) => {
          if (error) {
            console.warn("Profil non trouvé:", error.message);
          }
          setProfile(data);
          setLoading(false);
        });
    } else {
      setLoading(false);
    }
  }, [user?.id]);

  return { profile, loading };
};