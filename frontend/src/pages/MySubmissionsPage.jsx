import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getMySubmissions } from '../services/api';
import { Link } from 'react-router-dom';
import styles from './MySubmissionsPage.module.css';

const RESULTS_PER_PAGE = 15;

const MySubmissionsPage = () => {
    const { session } = useAuth();
    const [submissions, setSubmissions] = useState([]);
    const [totalCount, setTotalCount] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [isLoading, setIsLoading] = useState(true);

    const fetchSubmissions = (pageToFetch) => {
        if (session) {
            setIsLoading(true);
            getMySubmissions(session.access_token, pageToFetch, RESULTS_PER_PAGE)
                .then(res => {
                    setSubmissions(res.data.results);
                    setTotalCount(res.data.totalCount);
                    setCurrentPage(pageToFetch);
                })
                .catch(err => {
                    console.error("Erreur de chargement des soumissions:", err);
                })
                .finally(() => setIsLoading(false));
        }
    };

    useEffect(() => {
        if(session){
            fetchSubmissions(1);
        }
    }, [session?.access_token]);

    const totalPages = Math.ceil(totalCount / RESULTS_PER_PAGE);

    // Fonction helper pour déterminer la classe CSS du badge
    const getStatusClass = (status) => {
        switch(status) {
            case 'Validé': return `${styles.statusBadge} ${styles.statusValid}`;
            case 'Rejeté': return `${styles.statusBadge} ${styles.statusRejected}`;
            default: return `${styles.statusBadge} ${styles.statusPending}`;
        }
    };

    if (isLoading) {
        return (
            <div className={styles.container}>
                <p className={styles.emptyState}>Chargement de vos contributions...</p>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <h1 className={styles.title}>Mes Soumissions</h1>
                <p className={styles.description}>
                    Suivez l'état de validation de vos contributions.
                </p>
            </div>

            {submissions.length === 0 ? (
                <div className={styles.emptyState}>
                    Vous n'avez encore soumis aucune bulle.
                </div>
            ) : (
                <>
                    <div className={styles.tableWrapper}>
                        <table className={styles.table}>
                            <thead className={styles.thead}>
                                <tr>
                                    <th className={styles.th}>Texte Proposé</th>
                                    <th className={styles.th}>Localisation</th>
                                    <th className={styles.th}>Statut</th>
                                </tr>
                            </thead>
                            <tbody className={styles.tbody}>
                                {submissions.map(sub => (
                                    <tr key={sub.id}>
                                        <td className={`${styles.td} ${styles.bubbleText}`}>
                                            "{sub.texte_propose}"
                                        </td>
                                        <td className={styles.td}>
                                            <Link
                                                to={`/annotate/${sub.pages.id}`}
                                                className={styles.locationLink}
                                                title={`Voir la page ${sub.pages.numero_page}`}
                                            >
                                                Tome {sub.pages.chapitres.tomes.numero} • Chap {sub.pages.chapitres.numero} • P{sub.pages.numero_page}
                                            </Link>
                                        </td>
                                        <td className={styles.td}>
                                            <span className={getStatusClass(sub.statut)}>
                                                {sub.statut}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {totalPages > 1 && (
                        <div className={styles.pagination}>
                            <button
                                onClick={() => fetchSubmissions(currentPage - 1)}
                                disabled={currentPage === 1}
                                className={styles.pageButton}
                            >
                                Précédent
                            </button>
                            
                            <span className={styles.pageInfo}>
                                Page {currentPage} sur {totalPages}
                            </span>
                            
                            <button
                                onClick={() => fetchSubmissions(currentPage + 1)}
                                disabled={currentPage === totalPages}
                                className={styles.pageButton}
                            >
                                Suivant
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export default MySubmissionsPage;