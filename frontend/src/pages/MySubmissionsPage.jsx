import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getMySubmissions } from '../services/api';
import { Link } from 'react-router-dom';

const RESULTS_PER_PAGE = 10;

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
            case 'Validé': return { color: 'green', fontWeight: 'bold' };
            case 'Rejeté': return { color: 'red', fontWeight: 'bold' };
            default: return { color: 'orange', fontWeight: 'bold' };
        }
    };

    const totalPages = Math.ceil(totalCount / RESULTS_PER_PAGE);

    if (isLoading) return <p>Chargement de vos soumissions...</p>;

    return (
        <div style={{ padding: '2rem', maxWidth: '900px', margin: '0 auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h1>Mes Soumissions</h1>
                <Link to="/">Retour à l'accueil</Link>
            </div>
            <p>Voici la liste de toutes les bulles que vous avez annotées.</p>
            <hr />
            {submissions.length === 0 ? <p>Vous n'avez encore soumis aucune bulle.</p> : (
                <>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr>
                                <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Texte</th>
                                <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1-solid #ddd' }}>Localisation</th>
                                <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Statut</th>
                            </tr>
                        </thead>
                        <tbody>
                            {submissions.map(sub => (
                                <tr key={sub.id}>
                                    <td style={{ padding: '8px', borderBottom: '1px solid #ddd' }}>"{sub.texte_propose}"</td>
                                    <td style={{ padding: '8px', borderBottom: '1px solid #ddd' }}>
                                        <Link to={`/annotate/${sub.pages.id}`}>
                                            T{sub.pages.chapitres.tomes.numero}.C{sub.pages.chapitres.numero}.P{sub.pages.numero_page}
                                        </Link>
                                    </td>
                                    <td style={{ padding: '8px', borderBottom: '1px solid #ddd' }}>
                                        <span style={getStatusStyle(sub.statut)}>{sub.statut}</span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {totalPages > 1 && (
                        <div style={{display: 'flex', justifyContent: 'center', gap: '1rem', marginTop: '1rem'}}>
                            <button onClick={() => fetchSubmissions(currentPage - 1)} disabled={currentPage === 1}>Précédent</button>
                            <span>Page {currentPage} sur {totalPages}</span>
                            <button onClick={() => fetchSubmissions(currentPage + 1)} disabled={currentPage === totalPages}>Suivant</button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export default MySubmissionsPage;