import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
// Use AnnotatePage styles directly if they are common
import styles from '../pages/AnnotatePage.module.css';

export const SortableBubbleItem = ({ bubble, index, user, onEdit, onDelete }) => {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id: bubble.id });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
    };

    const itemClasses = `${styles.bubbleListItem} ${isDragging ? styles.bubbleListItemDragging : ''}`;

    return (
        <li ref={setNodeRef} style={style} className={itemClasses}>
            <div className={styles.bubbleItemContent} {...attributes} {...listeners}>
                <span className={styles.bubbleItemNumber}>{index + 1}</span>
                <span className={styles.bubbleItemText} title={bubble.texte_propose}>
                    {bubble.texte_propose || ''}
                </span>
            </div>
             {/* Wrap buttons in a div for layout */}
            {bubble.statut === 'Proposé' && user && bubble.id_user_createur === user.id && (
                <div className={styles.bubbleActions}>
                    <button onClick={() => onEdit(bubble)} className={styles.editButton} title="Modifier">✏️</button>
                    <button onClick={() => onDelete(bubble.id)} className={styles.deleteButton} title="Supprimer">🗑️</button>
                </div>
            )}
        </li>
    );
};