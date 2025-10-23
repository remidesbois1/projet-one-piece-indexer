import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getMySubmissions } from '../services/api';
import { Link } from 'react-router-dom';

const MySubmissionsPage = () => {
    const { session } = useAuth();
    const [submissions, setSubmissions] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        if (session) {
            getMySubmissions(session.access_token)
                .then(res => setSubmissions(res.data))
                .finally(() => setIsLoading(false));
        }
    }, [session]);

    const getStatusStyle = (status) => {
        switch(status) {
            case 'Validé': return { color: 'green', fontWeight: 'bold' };
            case 'Rejeté': return { color: 'red', fontWeight: 'bold' };
            default: return { color: 'orange', fontWeight: 'bold' };
        }
    };

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
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr>
                            <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Texte</th>
                            <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Localisation</th>
                            <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Statut</th>
                        </tr>
                    </thead>
                    <tbody>
                        {submissions.map(sub => (
                            <tr key={sub.id}>
                                <td style={{ padding: '8px', borderBottom: '1px solid #ddd' }}>"{sub.texte_propose}"</td>
                                <td style={{ padding: '8px', borderBottom: '1px solid #ddd' }}>
                                    {/* ON TRANSFORME LE TEXTE EN LIEN */}
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
            )}
        </div>
    );
};

export default MySubmissionsPage;