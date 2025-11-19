import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import styles from './Modal.module.css';

const Modal = ({ isOpen, onClose, title, children }) => {
    const [isDragging, setIsDragging] = useState(false);
    const [position, setPosition] = useState({ x: 0, y: 0 }); // Position relative par rapport au centre initial
    const [offset, setOffset] = useState({ x: 0, y: 0 }); // Offset de la souris par rapport au coin de la modale

    const modalRef = useRef(null); // Référence à la modale pour le déplacement

    useEffect(() => {
        if (isOpen) {
            // Centrer la modale à l'ouverture, mais seulement une fois
            const centerModal = () => {
                if (modalRef.current) {
                    const modalRect = modalRef.current.getBoundingClientRect();
                    const initialX = (window.innerWidth / 2) - (modalRect.width / 2);
                    const initialY = (window.innerHeight / 2) - (modalRect.height / 2);
                    setPosition({ x: initialX, y: initialY });
                }
            };
            centerModal();
            window.addEventListener('resize', centerModal); // Réajuster au redimensionnement
            return () => window.removeEventListener('resize', centerModal);
        }
    }, [isOpen]);

    // Gérer le début du drag
    const handleMouseDown = (e) => {
        // Ne commence le drag que si on clique sur le header
        if (!e.target.closest(`.${styles.modalHeader}`)) return;

        setIsDragging(true);
        if (modalRef.current) {
            const modalRect = modalRef.current.getBoundingClientRect();
            setOffset({
                x: e.clientX - modalRect.left,
                y: e.clientY - modalRect.top
            });
        }
    };

    // Gérer le déplacement
    const handleMouseMove = (e) => {
        if (!isDragging) return;
        setPosition({
            x: e.clientX - offset.x,
            y: e.clientY - offset.y
        });
    };

    // Gérer la fin du drag
    const handleMouseUp = () => {
        setIsDragging(false);
    };

    // Attacher les écouteurs de déplacement au document entier pour éviter de "perdre" la modale
    useEffect(() => {
        if (isDragging) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        } else {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        }
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging, offset]); // Dépend de isDragging et offset

    if (!isOpen) return null;

    // Calculer les styles dynamiques pour la position
    const modalStyle = {
        transform: `translate(${position.x}px, ${position.y}px)`,
        position: 'fixed', // Positionnement fixe pour un placement précis
        margin: 0, // Supprimer le margin auto par défaut du CSS
    };

    return ReactDOM.createPortal(
        <div className={styles.modalOverlay}>
            <div 
                ref={modalRef} 
                className={styles.modalContent} 
                style={modalStyle}
            >
                <div 
                    className={`${styles.modalHeader} ${isDragging ? styles.isDragging : ''}`}
                    onMouseDown={handleMouseDown}
                >
                    <h4 className={styles.modalTitle}>{title}</h4>
                    <button onClick={onClose} className={styles.closeButton}>&times;</button>
                </div>
                <div className={styles.modalBody}>
                    {children}
                </div>
            </div>
        </div>,
        document.body
    );
};

export default Modal;