import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import styles from './SortableBubbleItem.module.css';

export const SortableBubbleItem = ({ bubble, index, user, onEdit, onDelete, disabled }) => {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id: bubble.id, disabled: disabled });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 999 : 'auto',
    };

    const itemClasses = `${styles.bubbleListItem} ${isDragging ? styles.bubbleListItemDragging : ''}`;

    return (
        <li ref={setNodeRef} style={style} className={itemClasses}>
            <div className={styles.bubbleItemContent} {...attributes} {...listeners}>
                <div className={styles.dragHandle}>⋮⋮</div>
                <span className={styles.bubbleItemNumber}>{index + 1}</span>
                <span className={styles.bubbleItemText} title={bubble.texte_propose}>
                    {bubble.texte_propose || <em style={{color:'#999'}}>Sans texte</em>}
                </span>
            </div>

            {!disabled && bubble.statut === 'Proposé' && user && bubble.id_user_createur === user.id && (
                <div className={styles.bubbleActions}>
                    <button 
                        onClick={(e) => { e.stopPropagation(); onEdit(bubble); }} 
                        className={`${styles.actionButton} ${styles.editButton}`} 
                        title="Modifier le texte"
                    >
                        ✏️
                    </button>
                    <button 
                        onClick={(e) => { e.stopPropagation(); onDelete(bubble.id); }} 
                        className={`${styles.actionButton} ${styles.deleteButton}`} 
                        title="Supprimer l'annotation"
                    >
                        🗑️
                    </button>
                </div>
            )}
        </li>
    );
};