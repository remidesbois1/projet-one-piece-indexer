import React, { useState } from 'react';
import styles from './ValidationForm.module.css';

const ApiKeyForm = ({ onSave }) => {
    const [key, setKey] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        if (key.trim().length > 0) {
            onSave(key.trim());
        }
    };

    return (
        <form onSubmit={handleSubmit} className={styles.formContainer}>
            <div className={styles.header}>
                <h3 className={styles.title}>Configuration IA</h3>
                <p className={styles.subtitle}>
                    Une clé API Google Gemini est requise pour l'analyse automatique.
                    <br/>
                    <small>Elle sera stockée uniquement dans votre navigateur.</small>
                </p>
            </div>

            <div className={styles.fieldGroup}>
                <label className={styles.label}>Votre Clé API Google (AI Studio)</label>
                <input 
                    type="password"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder="Collez votre clé ici..."
                    className={styles.textarea}
                    style={{ minHeight: '40px', resize: 'none' }}
                    autoFocus
                />
                <div style={{marginTop: '0.5rem', fontSize: '0.85rem'}}>
                    <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style={{color: '#1a2b4c'}}>
                        Obtenir une clé gratuite ici &rarr;
                    </a>
                </div>
            </div>

            <div className={styles.footer}>
                <button 
                    type="submit" 
                    className={`${styles.button} ${styles.submitButton}`}
                    disabled={!key}
                >
                    Enregistrer et Continuer
                </button>
            </div>
        </form>
    );
};

export default ApiKeyForm;