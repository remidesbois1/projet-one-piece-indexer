import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import styles from '../pages/AnnotatePage.module.css';

export const SortableBubbleItem = ({ bubble, index, user, onDelete }) => {
    const { 
        attributes, 
        listeners, 
        setNodeRef, 
        transform, 
        transition,
        isDragging // On récupère l'état de déplacement
    } = useSortable({ id: bubble.id });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
    };
    
    // On ajoute une classe conditionnelle pour le style pendant le déplacement
    const itemClasses = `${styles.bubbleListItem} ${isDragging ? styles.bubbleListItemDragging : ''}`;

    return (
        <li ref={setNodeRef} style={style} className={itemClasses}>
            <div className={styles.bubbleItemContent} {...attributes} {...listeners}>
                <span className={styles.bubbleItemNumber}>{index + 1}</span>
                <span className={styles.bubbleItemText}>{(bubble.texte_propose || '').substring(0, 25)}...</span>
            </div>
            {bubble.statut === 'Proposé' && user && bubble.id_user_createur === user.id && (
                <button onClick={() => onDelete(bubble.id)} className={styles.deleteButton}>🗑️</button>
            )}
        </li>
    );
};