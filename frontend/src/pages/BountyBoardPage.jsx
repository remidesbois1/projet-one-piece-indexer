import React, { useState, useEffect } from 'react';
import { getStatsSummary, getTopContributors } from '../services/api';
import styles from './BountyBoardPage.module.css';
import { Link } from 'react-router-dom';

const BountyBoardPage = () => {
    const [summary, setSummary] = useState(null);
    const [contributors, setContributors] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const summaryRes = await getStatsSummary();
                const contributorsRes = await getTopContributors();
                setSummary(summaryRes.data);
                setContributors(contributorsRes.data);
            } catch (error) {
                console.error("Erreur de chargement des statistiques", error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchData();
    }, []);

    if (isLoading) return <div>Chargement du tableau des primes...</div>;

    return (
        <div className={styles.board}>
            <div className={styles.headerContainer}>
                <Link to="/" className={styles.backLink}>&larr; Retour à la Bibliothèque</Link>
                <header className={styles.header}>
                    <h1>TABLEAU DES PRIMES</h1>
                    <p>Récompenses pour les plus grands contributeurs à la connaissance mondiale.</p>
                </header>
            </div>

            {summary && (
                <div className={styles.summary}>
                    <div className={styles.statItem}>
                        <div className={styles.statValue}>{(summary.total_bulles_validees || 0).toLocaleString()}</div>
                        <div className={styles.statLabel}>Bulles Indexées</div>
                    </div>
                    <div className={styles.statItem}>
                        <div className={styles.statValue}>{(summary.total_contributeurs || 0).toLocaleString()}</div>
                        <div className={styles.statLabel}>Contributeurs Actifs</div>
                    </div>
                    <div className={styles.statItem}>
                        <div className={styles.statValue}>{(summary.total_pages_completees || 0).toLocaleString()}</div>
                        <div className={styles.statLabel}>Pages Complétées</div>
                    </div>
                </div>
            )}
            
            <div className={styles.postersGrid}>
                {contributors.map((pirate) => (
                    <div key={pirate.user_id} className={styles.wantedPoster}>
                        <div className={styles.posterImage}>
                            <img src={`https://api.dicebear.com/7.x/pixel-art/svg?seed=${pirate.username}`} alt="avatar" width="200" height="200" />
                        </div>
                        <p className={styles.pirateName}>{pirate.username}</p>
                        <p className={styles.bountyAmount}>{(pirate.bounty || 0).toLocaleString()}</p>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default BountyBoardPage;