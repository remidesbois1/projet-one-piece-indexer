import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getMySubmissions } from '../services/api';
import { Link } from 'react-router-dom';

const RESULTS_PER_PAGE = 15;

// Styles pour la page
const styles = {
    container: {
        padding: '0', /* Handled by Layout */
        maxWidth: '900px',
        margin: '0 auto'
    },
    header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '1rem',
        borderBottom: `2px solid var(--color-wood)`,
        paddingBottom: '1rem',
    },
    title: {
         fontFamily: 'var(--font-title)',
         color: 'var(--color-navy)',
         fontSize: '2.5rem',
         margin: 0,
    },
    link: {
        color: 'var(--color-navy)',
        fontWeight: 'bold',
        textDecoration: 'none',
    },
    description: {
      fontFamily: 'var(--font-text)',
      marginBottom: '1.5rem',
      color: 'var(--color-text-dark)',
    },
    table: {
        width: '100%',
        borderCollapse: 'collapse',
        marginTop: '1.5rem',
        backgroundColor: '#fff',
        boxShadow: '0 2px 5px rgba(0,0,0,0.1)',
        borderRadius: '4px',
        overflow: 'hidden',
    },
    th: {
        textAlign: 'left',
        padding: '12px 15px',
        borderBottom: `2px solid var(--color-wood)`,
        backgroundColor: 'var(--color-parchment)',
        fontFamily: 'var(--font-text)',
        fontWeight: 'bold',
        color: 'var(--color-wood)',
    },
    td: {
        padding: '10px 15px',
        borderBottom: '1px solid #eee',
        fontFamily: 'var(--font-text)',
        verticalAlign: 'top',
    },
    tdLink: {
        color: 'var(--color-navy)',
        fontWeight: 'bold',
    },
    statusBase: {
        fontWeight: 'bold',
        padding: '3px 8px',
        borderRadius: '4px',
        fontSize: '0.85rem',
        display: 'inline-block',
        textAlign: 'center',
    },
    statusValid: {
        color: 'var(--color-status-valid)',
        backgroundColor: '#d2f4e1ff',
    },
    statusRejected: {
        color: 'var(--color-status-rejected)',
        backgroundColor: '#fce8e8',
    },
    statusPending: {
        color: 'var(--color-status-pending)',
        backgroundColor: '#fff8e1',
    },
    pagination: {
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: '1rem',
        marginTop: '2rem',
    },
    paginationButton: {
        padding: '8px 16px',
        cursor: 'pointer',
    },
    paginationButtonDisabled: {
        cursor: 'not-allowed',
        opacity: 0.6,
    }
};

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
    }, [session]);

    const getStatusStyle = (status) => {
        switch(status) {
            case 'Validé': return { ...styles.statusBase, ...styles.statusValid };
            case 'Rejeté': return { ...styles.statusBase, ...styles.statusRejected };
            default: return { ...styles.statusBase, ...styles.statusPending };
        }
    };

    const totalPages = Math.ceil(totalCount / RESULTS_PER_PAGE);

    if (isLoading) return <p>Chargement de vos soumissions...</p>;

    return (
        <div style={styles.container}>
            <div style={styles.header}>
                <h1 style={styles.title}>Mes Soumissions</h1>
            </div>
            <p style={styles.description}>Voici la liste de toutes les bulles que vous avez annotées et leur statut actuel.</p>

            {submissions.length === 0 ? <p>Vous n'avez encore soumis aucune bulle.</p> : (
                <>
                    <table style={styles.table}>
                        <thead>
                            <tr>
                                <th style={styles.th}>Texte Proposé</th>
                                <th style={styles.th}>Localisation</th>
                                <th style={styles.th}>Statut</th>
                            </tr>
                        </thead>
                        <tbody>
                            {submissions.map(sub => (
                                <tr key={sub.id}>
                                    <td style={styles.td}>"{sub.texte_propose}"</td>
                                    <td style={styles.td}>
                                        <Link
                                            to={`/annotate/${sub.pages.id}`}
                                            style={styles.tdLink}
                                            title={`Aller à la page ${sub.pages.numero_page}`}
                                        >
                                            T{sub.pages.chapitres.tomes.numero} C{sub.pages.chapitres.numero} P{sub.pages.numero_page}
                                        </Link>
                                    </td>
                                    <td style={styles.td}>
                                        <span style={getStatusStyle(sub.statut)}>{sub.statut}</span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    {totalPages > 1 && (
                        <div style={styles.pagination}>
                            <button
                                onClick={() => fetchSubmissions(currentPage - 1)}
                                disabled={currentPage === 1}
                                style={currentPage === 1 ? {...styles.paginationButton, ...styles.paginationButtonDisabled} : styles.paginationButton}
                            >
                                Précédent
                            </button>
                            <span>Page {currentPage} sur {totalPages}</span>
                            <button
                                onClick={() => fetchSubmissions(currentPage + 1)}
                                disabled={currentPage === totalPages}
                                style={currentPage === totalPages ? {...styles.paginationButton, ...styles.paginationButtonDisabled} : styles.paginationButton}
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